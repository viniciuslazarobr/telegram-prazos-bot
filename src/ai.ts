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
1. process_number: Número do processo (ex: "0012345-67.2024.8.26.0100" ou "12345"). Se não foi informado explicitamente, tente identificar qualquer código ou número citado; se realmente não houver, use "A DEFINIR".
2. client_name: Nome do cliente ou partes envolvidas (ex: "Banco do Brasil", "João da Silva", "Empresa X").
3. deadline_info: O que precisa ser feito / qual é o prazo (ex: "Contestação", "Recurso de Apelação", "Réplica", "Juntada de Guia", "Audiência").
4. due_date: Data final do vencimento no formato estrito "YYYY-MM-DD".
   - Calcule com base na data de hoje (${dateStr}).
   - Se o usuário disser "amanhã", "próxima terça", "dia 15", "fim do mês", converta precisamente para YYYY-MM-DD.
   - O ano deve ser consistente com o contexto.
5. remind_days_before: Quantos dias de antecedência começar a alertar (número inteiro). Se o usuário não citar, retorne 3 (padrão).

FORMATO DA RESPOSTA:
Retorne APENAS um objeto JSON válido, sem blocos de markdown adicionais, sem texto antes ou depois:
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
      // Tenta primeiramente gemini-2.5-flash, com fallback para gemini-1.5-flash
      const modelNames = ['gemini-2.5-flash', 'gemini-1.5-flash'];
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
          // Continua para o próximo modelo se falhar
          continue;
        }
      }
    } catch (err) {
      console.warn('[AI] Falha na chamada da Gemini API para texto:', err);
    }
  }

  // 2. Fallback por Expressões Regulares / Sintaxe Estruturada
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

  const modelNames = ['gemini-2.5-flash', 'gemini-1.5-flash'];
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
    process_number: String(item.process_number || 'A DEFINIR').trim(),
    client_name: String(item.client_name || 'Não informado').trim(),
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
function fallbackRegexParser(text: string): ParsedDeadline | null {
  // Padrão 1: separado por pipes: Nº | Cliente | Prazo | DD/MM/AAAA [| Dias]
  if (text.includes('|')) {
    const parts = text.split('|').map((p) => p.trim());
    if (parts.length >= 4) {
      const isoDate = parseDateBRToISO(parts[3]);
      if (isoDate) {
        const days = parts[4] ? parseInt(parts[4], 10) : 3;
        return {
          process_number: parts[0],
          client_name: parts[1],
          deadline_info: parts[2],
          due_date: isoDate,
          remind_days_before: isNaN(days) ? 3 : days,
        };
      }
    }
  }

  // Padrão 2: tags nomeadas (ex: Processo: X, Cliente: Y, Prazo: Z, Data: DD/MM/AAAA)
  const procMatch = text.match(/processo[:\s]+([^\n,;|]+)/i);
  const cliMatch = text.match(/cliente[:\s]+([^\n,;|]+)/i);
  const prazoMatch = text.match(/prazo[:\s]+([^\n,;|]+)/i);
  const dataMatch = text.match(/(?:data|vencimento|vence|dia)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i);

  if (procMatch && cliMatch && prazoMatch && dataMatch) {
    const isoDate = parseDateBRToISO(dataMatch[1]);
    if (isoDate) {
      return {
        process_number: procMatch[1].trim(),
        client_name: cliMatch[1].trim(),
        deadline_info: prazoMatch[1].trim(),
        due_date: isoDate,
        remind_days_before: 3,
      };
    }
  }

  return null;
}
