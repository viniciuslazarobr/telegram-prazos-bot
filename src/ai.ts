import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config';
import { getTodayDateString, parseDateBRToISO } from './supabase';

export interface ParsedDeadline {
  process_number: string;
  client_name: string;
  deadline_info: string;
  due_date: string; // YYYY-MM-DD
  remind_days_before: number;
}

let genAI: GoogleGenerativeAI | null = null;
if (config.geminiApiKey) {
  genAI = new GoogleGenerativeAI(config.geminiApiKey);
}

/**
 * Cria o prompt de sistema com contexto temporal exato no fuso de Brasília.
 */
function buildSystemPrompt(): string {
  const now = new Date();
  const dateStr = getTodayDateString();
  const dayOfWeek = now.toLocaleDateString('pt-BR', {
    timeZone: config.timezone,
    weekday: 'long',
  });

  return `
Você é o assistente inteligente de um escritório de advocacia responsável por extrair dados de novos prazos processuais a partir de mensagens em texto ou áudio da equipe.

CONTEXTO TEMPORAL ATUAL:
- Data de hoje: ${dateStr} (${dayOfWeek})
- Fuso Horário: America/Sao_Paulo (Horário de Brasília)

SUA MISSÃO:
Extrair os seguintes campos obrigatórios com precisão:
1. process_number: Número do processo (ex: "0012345-67.2024.8.26.0100" ou "123"). Limpe pontos finais ou caracteres extras.
2. client_name: Nome do cliente ou partes envolvidas (ex: "Ali", "Banco do Brasil", "João da Silva").
3. deadline_info: O que precisa ser feito / qual é o prazo (ex: "Contestação", "Vencimento às 13:30", "Réplica"). Se houver horário citado (ex: 13:30), preserve o horário na descrição!
4. due_date: Data final do vencimento no formato estrito "YYYY-MM-DD".
   - Se for "hoje", use ${dateStr}.
   - Se for "amanhã", calcule o dia seguinte a ${dateStr}.
   - Se houver data explícita (ex: 25/10/2026), converta para YYYY-MM-DD.
5. remind_days_before: Quantos dias de antecedência começar a alertar (número inteiro). Padrão: 3. Se for hoje ou amanhã, use 1 ou 3.

FORMATO DA RESPOSTA:
Retorne APENAS um objeto JSON válido, sem blocos de markdown adicionais:
{
  "process_number": "...",
  "client_name": "...",
  "deadline_info": "...",
  "due_date": "YYYY-MM-DD",
  "remind_days_before": 3
}
`;
}

/**
 * Extrai dados do prazo a partir de texto livre usando Gemini ou fallback regex.
 */
export async function parseDeadlineFromText(text: string): Promise<ParsedDeadline | null> {
  const trimmed = text.trim();

  // 1. Tentar via Gemini se a chave estiver configurada
  if (genAI) {
    try {
      const modelNames = ['gemini-1.5-flash', 'gemini-1.5-pro'];
      for (const modelName of modelNames) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: buildSystemPrompt(),
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
            },
          });

          const result = await model.generateContent(trimmed);
          const rawResponse = result.response.text();
          const parsed = sanitizeAndParseJson<ParsedDeadline>(rawResponse);

          if (parsed && isValidParsedDeadline(parsed)) {
            return normalizeParsedDeadline(parsed);
          }
        } catch (innerErr) {
          continue;
        }
      }
    } catch (err) {
      console.warn('[AI] Falha na chamada da Gemini API para texto:', err);
    }
  }

  // 2. Fallback inteligente por Expressões Regulares (compreende todos os formatos estruturados e naturais)
  return fallbackRegexParser(trimmed);
}

/**
 * Extrai dados do prazo a partir de áudio/voz do Telegram usando Gemini Multimodal.
 */
export async function parseDeadlineFromAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/ogg'
): Promise<ParsedDeadline | null> {
  if (!genAI) {
    console.warn('[AI] GEMINI_API_KEY não configurada. Não é possível transcrever áudio.');
    return null;
  }

  const modelNames = ['gemini-1.5-flash', 'gemini-1.5-pro'];
  for (const modelName of modelNames) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: buildSystemPrompt(),
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const audioPart = {
        inlineData: {
          data: audioBuffer.toString('base64'),
          mimeType: mimeType || 'audio/ogg',
        },
      };

      const prompt = 'Ouça este áudio e extraia os dados do prazo processual conforme as instruções.';
      const result = await model.generateContent([prompt, audioPart]);
      const rawResponse = result.response.text();
      const parsed = sanitizeAndParseJson<ParsedDeadline>(rawResponse);

      if (parsed && isValidParsedDeadline(parsed)) {
        return normalizeParsedDeadline(parsed);
      }
    } catch (err) {
      console.warn(`[AI] Falha ao processar áudio com ${modelName}:`, err);
    }
  }

  return null;
}

/**
 * Validação dos campos mínimos obrigatórios
 */
function isValidParsedDeadline(item: any): boolean {
  return (
    item &&
    typeof item.process_number === 'string' &&
    typeof item.client_name === 'string' &&
    typeof item.deadline_info === 'string' &&
    typeof item.due_date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(item.due_date)
  );
}

/**
 * Normaliza campos retornados pelo modelo
 */
function normalizeParsedDeadline(item: any): ParsedDeadline {
  return {
    process_number: String(item.process_number || 'A DEFINIR').replace(/[.,;:]+$/, '').trim(),
    client_name: String(item.client_name || 'Não informado').replace(/[.,;:]+$/, '').trim(),
    deadline_info: String(item.deadline_info || 'Prazo geral').trim(),
    due_date: String(item.due_date).trim(),
    remind_days_before: typeof item.remind_days_before === 'number' && item.remind_days_before > 0
      ? item.remind_days_before
      : 3,
  };
}

/**
 * Limpa markdown e converte para JSON com segurança
 */
function sanitizeAndParseJson<T>(raw: string): T | null {
  try {
    let clean = raw.trim();
    if (clean.startsWith('```json')) {
      clean = clean.replace(/^```json\s*/, '').replace(/```\s*$/, '');
    } else if (clean.startsWith('```')) {
      clean = clean.replace(/^```\s*/, '').replace(/```\s*$/, '');
    }
    return JSON.parse(clean) as T;
  } catch (err) {
    return null;
  }
}

/**
 * Parser de fallback via Regex para quando a IA não estiver ativa ou o usuário usar padrões simples
 */
export function fallbackRegexParser(text: string): ParsedDeadline | null {
  const clean = text.trim();

  // Padrão 1: separado por pipes: Nº | Cliente | Prazo | DD/MM/AAAA [| Dias]
  if (clean.includes('|')) {
    const parts = clean.split('|').map((p) => p.trim());
    if (parts.length >= 4) {
      const isoDate = parseDateBRToISO(parts[3]);
      if (isoDate) {
        const days = parts[4] ? parseInt(parts[4], 10) : 3;
        return {
          process_number: parts[0].replace(/[.,;:]+$/, '').trim(),
          client_name: parts[1].replace(/[.,;:]+$/, '').trim(),
          deadline_info: parts[2].trim(),
          due_date: isoDate,
          remind_days_before: isNaN(days) ? 3 : days,
        };
      }
    }
  }

  // Extração de data: aceita DD/MM/AAAA, DD/MM, "hoje", "amanhã"
  let isoDate: string | null = null;
  const todayStr = getTodayDateString();
  const [tY, tM, tD] = todayStr.split('-').map(Number);

  // Data explícita DD/MM/AAAA ou DD/MM
  const explicitDateMatch = clean.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (explicitDateMatch) {
    const d = explicitDateMatch[1].padStart(2, '0');
    const m = explicitDateMatch[2].padStart(2, '0');
    const y = explicitDateMatch[3]
      ? explicitDateMatch[3].length === 2
        ? '20' + explicitDateMatch[3]
        : explicitDateMatch[3]
      : String(tY);
    isoDate = `${y}-${m}-${d}`;
  } else if (/hoje/i.test(clean)) {
    isoDate = todayStr;
  } else if (/amanh[aã]/i.test(clean)) {
    const tm = new Date(Date.UTC(tY, tM - 1, tD + 1));
    isoDate = tm.toISOString().split('T')[0];
  }

  // Extração de horário (ex: "às 13:30", "13h30", "13:30")
  const timeMatch = clean.match(/(?:às|as)?\s*(\d{1,2})(?:[:h](\d{2}))?/i);
  let timeStr = '';
  if (
    timeMatch &&
    (clean.toLowerCase().includes('às') ||
      clean.toLowerCase().includes('as ') ||
      timeMatch[0].includes(':') ||
      timeMatch[0].toLowerCase().includes('h'))
  ) {
    const hh = timeMatch[1].padStart(2, '0');
    const mm = (timeMatch[2] || '00').padStart(2, '0');
    timeStr = ` (às ${hh}:${mm})`;
  }

  // Padrão 2: tags nomeadas (ex: Processo: X, Cliente: Y, Prazo: Z)
  const procMatch = clean.match(/processo[:\s]+([^\n,;|]+)/i);
  const cliMatch = clean.match(/cliente[:\s]+([^\n,;|]+)/i);
  const prazoMatch = clean.match(/prazo[:\s]+([^\n,;|]+)/i);

  if (procMatch && cliMatch && (isoDate || prazoMatch)) {
    const rawProc = procMatch[1].replace(/[.,;:]+$/, '').trim();
    const rawCli = cliMatch[1].replace(/[.,;:]+$/, '').trim();
    let rawPrazo = prazoMatch ? prazoMatch[1].trim() : 'Prazo processual';

    if (timeStr && !rawPrazo.includes(timeStr)) {
      rawPrazo += timeStr;
    }

    return {
      process_number: rawProc || '123',
      client_name: rawCli || 'Cliente',
      deadline_info: rawPrazo,
      due_date: isoDate || todayStr,
      remind_days_before: 3,
    };
  }

  // Padrão 3: texto natural (ex: "Processo 123 do cliente Ali contestação vence hoje às 13:30")
  if (isoDate) {
    const numMatch = clean.match(/(?:processo|n[ºo°]?)\s*[:.]?\s*([a-zA-Z0-9\-\.\/]+)/i);
    const clientMatch = clean.match(
      /(?:cliente|parte|do|da)\s*[:.]?\s*([a-zA-ZÀ-ÿ\s]{2,30}?)(?=\s+(?:prazo|vence|vencimento|dia|às|com|,|$))/i
    );
    const taskMatch = clean.match(/(?:prazo|tarefa|para)\s*[:.]?\s*([^\n,;]+)/i);

    const proc = numMatch ? numMatch[1].replace(/[.,;:]+$/, '').trim() : '123';
    const cli = clientMatch ? clientMatch[1].replace(/[.,;:]+$/, '').trim() : 'Cliente';
    const task = (taskMatch ? taskMatch[1].trim() : 'Prazo processual') + timeStr;

    return {
      process_number: proc,
      client_name: cli,
      deadline_info: task,
      due_date: isoDate,
      remind_days_before: 3,
    };
  }

  return null;
}
