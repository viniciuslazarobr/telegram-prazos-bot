import dotenv from 'dotenv';
dotenv.config();

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[Config Error] Variável de ambiente obrigatória não encontrada: ${key}`);
  }
  return value.trim();
}

/**
 * Normaliza a URL do Supabase para o endpoint REST real caso o usuário tenha colado
 * a URL do painel web (dashboard) do navegador.
 */
export function normalizeSupabaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const match = trimmed.match(/supabase\.com\/dashboard\/project\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return `https://${match[1]}.supabase.co`;
  }
  return trimmed.replace(/\/+$/, '');
}

export const config = {
  telegramBotToken: getEnvOrThrow('TELEGRAM_BOT_TOKEN'),
  supabaseUrl: normalizeSupabaseUrl(getEnvOrThrow('SUPABASE_URL')),
  supabaseServiceRoleKey: getEnvOrThrow('SUPABASE_SERVICE_ROLE_KEY'),
  port: parseInt(process.env.PORT || '3000', 10),
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
  timezone: process.env.TIMEZONE?.trim() || 'America/Sao_Paulo',
};
