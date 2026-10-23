import express, { Request, Response } from 'express';
import { config } from './config';
import { getOfficeGroupChatId, getTodayDateString } from './supabase';

export const recentEvents: Array<{ time: string; type: string; details: any }> = [];

export function logEvent(type: string, details: any) {
  recentEvents.unshift({
    time: new Date().toISOString(),
    type,
    details,
  });
  if (recentEvents.length > 30) recentEvents.pop();
}

export const app = express();
app.use(express.json());

const startTime = new Date();

// Rota raiz para conferência e visualização no navegador
app.get('/', async (_req: Request, res: Response) => {
  const officeGroupChatId = await getOfficeGroupChatId();
  const uptimeSeconds = Math.floor((Date.now() - startTime.getTime()) / 1000);

  res.json({
    name: 'Bot de Prazos do Escritório (Telegram)',
    status: 'ONLINE',
    uptimeSeconds,
    uptimeHuman: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
    startedAt: startTime.toISOString(),
    todaySaoPaulo: getTodayDateString(config.timezone),
    timezone: config.timezone,
    officeGroupConfigured: Boolean(officeGroupChatId),
    officeGroupChatId: officeGroupChatId || 'Não configurado (use /definir_grupo no grupo)',
    geminiEnabled: Boolean(config.geminiApiKey),
    message: 'Serviço ativo e monitorado via UptimeRobot no Render.',
  });
});

// Endpoint de Healthcheck para o UptimeRobot manter o Render 24/7 acordado
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Endpoint de diagnóstico para depuração em tempo real
app.get('/debug', async (_req: Request, res: Response) => {
  const officeGroupChatId = await getOfficeGroupChatId();
  res.json({
    officeGroupChatId,
    officeGroupConfigured: Boolean(officeGroupChatId),
    recentEvents,
  });
});

/**
 * Inicia o servidor HTTP Express
 */
export function startServer(port: number = config.port) {
  return app.listen(port, () => {
    console.log(`[HTTP] Servidor Express Keep-Alive rodando na porta ${port}`);
    console.log(`[HTTP] Healthcheck ativo em: http://localhost:${port}/health`);
  });
}
