import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config';
import { getTodayDateString, parseDateBRToISO } from './supabase';

export interface ParsedDeadline {
  process_number: string;
  client_name: string;
  deadline_info: string;
  due_date: string; // YYYY-MM-DD
  remind_days_before: number;
  responsible_name?: string; // Atribuição a colega/chefe/amigo
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
3. deadline_info: O que precisa ser feito / qual é o prazo (ex: "Contestação às 13:55", "Vencimento às 13:55", "Réplica"). Se houver horário citado, preserve o horário na descrição sem duplicar!
4. due_date: Data final do vencimento no formato estrito "YYYY-MM-DD".
   - Se for "hoje", use ${dateStr}.
   - Se for "amanhã", calcule o dia seguinte a ${dateStr}.
   - Se houver data explícita (ex: 25/10/2026), converta para YYYY-MM-DD.
5. remind_days_before: Quantos dias de antecedência começar a alertar (número inteiro). Padrão: 3.
6. responsible_name: Nome da pessoa responsável pelo prazo (ex: "Chefe", "Alexandre", "Amigo", "Irmão", "Dr. João"). Se citado ("para o chefe", "responsável: Amigo"), extraia aqui. Se não citado, retorne null.

FORMATO DA RESPOSTA:
Retorne APENAS um objeto JSON válido, sem blocos de markdown adicionais:
{
  "process_number": "...",
  "client_name": "...",
  "deadline_info": "...",
  "due_date": "YYYY-MM-DD",
  "remind_days_before": 3,
  "responsible_name": null
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
      const modelNames = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
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

  // 2. Fallback inteligente por Expressões Regulares
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

  const modelNames = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
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

function isValidParsedDeadline(item: any): boolean {
  if (
    !item ||
    typeof item.process_number !== 'string' ||
    typeof item.client_name !== 'string' ||
    typeof item.deadline_info !== 'string' ||
    typeof item.due_date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(item.due_date)
  ) {
    return false;
  }
  const [y, m, d] = item.due_date.split('-').map(Number);
  return y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function normalizeParsedDeadline(item: any): ParsedDeadline {
  return {
    process_number: String(item.process_number || 'A DEFINIR').replace(/[.,;:]+$/, '').trim(),
    client_name: String(item.client_name || 'Não informado').replace(/[.,;:]+$/, '').trim(),
    deadline_info: String(item.deadline_info || 'Prazo geral').trim(),
    due_date: String(item.due_date).trim(),
    remind_days_before:
      typeof item.remind_days_before === 'number' && item.remind_days_before > 0 ? item.remind_days_before : 3,
    responsible_name: item.responsible_name ? String(item.responsible_name).replace(/[.,;:]+$/, '').trim() : undefined,
  };
}

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
 * Extrai uma data válida (DD/MM/AAAA ou DD/MM) ignorando falsos positivos de números de processo
 */
function extractValidDateFromText(textToSearch: string, defaultYear: number): string | null {
  const dateRegex = /(?:^|[^\d.])(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?!\d)/g;
  let match: RegExpExecArray | null;

  while ((match = dateRegex.exec(textToSearch)) !== null) {
    const dayNum = parseInt(match[1], 10);
    const monthNum = parseInt(match[2], 10);

    if (dayNum >= 1 && dayNum <= 31 && monthNum >= 1 && monthNum <= 12) {
      const d = String(dayNum).padStart(2, '0');
      const m = String(monthNum).padStart(2, '0');
      const y = match[3]
        ? match[3].length === 2
          ? '20' + match[3]
          : match[3]
        : String(defaultYear);

      const yearNum = parseInt(y, 10);
      if (yearNum >= 2020 && yearNum <= 2100) {
        return `${y}-${m}-${d}`;
      }
    }
  }
  return null;
}

/**
 * Parser de fallback via Regex para quando a IA não estiver ativa ou o usuário usar padrões estruturados
 */
export function fallbackRegexParser(text: string): ParsedDeadline | null {
  const clean = text.trim();

  // Padrão 1: separado por pipes: Nº | Cliente | Prazo | DD/MM/AAAA [| Responsável ou Dias] [| Dias]
  if (clean.includes('|')) {
    const parts = clean.split('|').map((p) => p.trim());
    if (parts.length >= 4) {
      const isoDate = parseDateBRToISO(parts[3]);
      if (isoDate) {
        let responsibleName: string | undefined = undefined;
        let days = 3;

        if (parts[4]) {
          const parsedNum = parseInt(parts[4], 10);
          if (isNaN(parsedNum)) {
            responsibleName = parts[4].replace(/[.,;:]+$/, '').trim();
          } else {
            days = parsedNum;
          }
        }

        if (parts[5]) {
          const parsedNum = parseInt(parts[5], 10);
          if (isNaN(parsedNum)) {
            responsibleName = parts[5].replace(/[.,;:]+$/, '').trim();
          } else {
            days = parsedNum;
          }
        }

        return {
          process_number: parts[0].replace(/[.,;:]+$/, '').trim(),
          client_name: parts[1].replace(/[.,;:]+$/, '').trim(),
          deadline_info: parts[2].trim(),
          due_date: isoDate,
          remind_days_before: isNaN(days) ? 3 : days,
          responsible_name: responsibleName,
        };
      }
    }
  }

  // Padrão 2: tags nomeadas com dois pontos (ex: Processo: X, Cliente: Y, Prazo: Z)
  const procMatch = clean.match(/processo\s*:\s*([^\n,;|]+)/i);
  const cliMatch = clean.match(/cliente\s*:\s*([^\n,;|]+)/i);
  const prazoMatch = clean.match(/prazo\s*:\s*([^\n,;|]+)/i);
  const dataTagMatch = clean.match(/(?:data|vencimento)\s*:\s*([^\n,;|]+)/i);

  // Removemos a linha do Processo (e números CNJ longos) antes de procurar datas e horários
  // para que "1020.2026/0052908-9" nunca seja confundido com uma data!
  const textWithoutProcess = clean
    .replace(/processo\s*:\s*[^\n,;|]+/gi, '')
    .replace(/\b\d{4,}[\.\-\/]\d+[\.\-\/\d]*\b/g, '');

  // Extração de data: prioriza a linha Data:/Prazo:, senão busca no texto limpo (sem o nº do processo)
  let isoDate: string | null = null;
  const todayStr = getTodayDateString();
  const [tY, tM, tD] = todayStr.split('-').map(
