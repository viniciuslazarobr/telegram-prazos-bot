import dotenv from 'dotenv';
dotenv.config();

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[Config Error] Variável de ambiente obrigatória não encontrada: ${key}`);
  }
  return value.trim();
}

export const config = {
  telegramBotToken: getEnvOrThrow('TELEGRAM_BOT_TOKEN'),
  supabaseUrl: getEnvOrThrow('SUPABASE_URL'),
  supabaseServiceRoleKey: getEnvOrThrow('SUPABASE_SERVICE_ROLE_KEY'),
  port: parseInt(process.env.PORT || '3000', 10),
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
  timezone: process.env.TIMEZONE?.trim() || 'America/Sao_Paulo',
};
