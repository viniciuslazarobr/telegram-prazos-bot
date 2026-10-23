import { bot } from './bot';
import { setupCronJobs } from './cron';
import { startServer } from './server';
import { config } from './config';
import { getOfficeGroupChatId } from './supabase';

async function bootstrap() {
  console.log('====================================================');
  console.log('🚀 INICIANDO BOT DE PRAZOS MULTI-USUÁRIO DO ESCRITÓRIO');
  console.log('====================================================');
  console.log(`[Config] Fuso Horário: ${config.timezone}`);
  console.log(`[Config] Porta HTTP: ${config.port}`);
  console.log(`[Config] Gemini IA: ${config.geminiApiKey ? 'Ativo ✅' : 'Desativado (Regex ativo) ⚠️'}`);

  // 1. Inicia o Servidor HTTP (para manter o Render acordado via UptimeRobot)
  const server = startServer(config.port);

  // 2. Configura os agendamentos do Cron (08:30, 14:00, 17:00)
  setupCronJobs(bot);

  // 3. Verifica configuração do grupo geral
  try {
    const groupId = await getOfficeGroupChatId();
    if (groupId) {
      console.log(`[Config] Grupo Geral do Escritório vinculado: ${groupId} ✅`);
    } else {
      console.log('[Config] ⚠️ Nenhum Grupo Geral configurado ainda. Use o comando /definir_grupo no grupo da equipe.');
    }
  } catch (err) {
    console.warn('[Config] Aviso: Não foi possível checar o grupo inicial do escritório no Supabase:', err);
  }

  // 4. Inicia o Bot do Telegram via Long Polling
  console.log('[Bot] Conectando ao Telegram...');
  bot.start({
    onStart: (botInfo) => {
      console.log(`[Bot] ✅ Bot @${botInfo.username} iniciado com sucesso via Long Polling!`);
      console.log(`[Bot] Pronto para receber mensagens de voz, textos e comandos.`);
    },
  });

  // Tratamento de encerramento suave (Graceful Shutdown)
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Recebido sinal ${signal}. Encerrando aplicação graciosamente...`);
    try {
      await bot.stop();
      server.close(() => {
        console.log('[Shutdown] Servidor HTTP encerrado.');
        process.exit(0);
      });
    } catch (err) {
      console.error('[Shutdown] Erro ao encerrar:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('[FATAL] Erro fatal na inicialização da aplicação:', err);
  process.exit(1);
});
