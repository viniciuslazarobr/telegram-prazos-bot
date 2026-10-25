import express, { Request, Response } from 'express';
import { config } from './config';
import {
  getOfficeGroupChatId,
  setOfficeGroupChatId,
  getTodayDateString,
  supabase,
  DEFAULT_OFFICE_GROUP_ID,
} from './supabase';

export const recentEvents: Array<{ time: string; type: string; details: any }> = [];

export function logEvent(type: string, details: any) {
  recentEvents.unshift({
    time: new Date().toISOString(),
    type,
    details,
  });
  if (recentEvents.length > 50) recentEvents.pop();
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
    officeGroupChatId: officeGroupChatId || DEFAULT_OFFICE_GROUP_ID,
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

// Endpoint de diagnóstico detalhado com erros do Supabase
app.get('/debug', async (_req: Request, res: Response) => {
  const officeGroupChatId = await getOfficeGroupChatId();
  
  const { data: members, error: membersError } = await supabase.from('team_members').select('*');
  const { data: processes, error: processesError } = await supabase.from('processes').select('*');
  const { data: settings, error: settingsError } = await supabase.from('app_settings').select('*');

  res.json({
    officeGroupChatId: officeGroupChatId || DEFAULT_OFFICE_GROUP_ID,
    officeGroupConfigured: Boolean(officeGroupChatId),
    supabaseStatus: {
      url: config.supabaseUrl,
      keyPrefix: config.supabaseServiceRoleKey?.substring(0, 15) + '...',
      membersError: membersError ? { message: membersError.message, code: membersError.code, details: membersError.details, hint: membersError.hint } : null,
      processesError: processesError ? { message: processesError.message, code: processesError.code, details: processesError.details, hint: processesError.hint } : null,
      settingsError: settingsError ? { message: settingsError.message, code: settingsError.code, details: settingsError.details, hint: settingsError.hint } : null,
    },
    membersCount: members ? members.length : 0,
    members: members || [],
    processesCount: processes ? processes.length : 0,
    processes: processes || [],
    settingsData: settings || [],
    recentEvents,
  });
});

// Endpoint para vincular o grupo do escritório com 1 clique / chamada HTTP
app.get('/api/set-office-group', async (req: Request, res: Response) => {
  const chatId = req.query.chatId ? String(req.query.chatId) : DEFAULT_OFFICE_GROUP_ID;

  try {
    await setOfficeGroupChatId(chatId);
    logEvent('manual_set_group_http', { chatId });

    res.json({
      success: true,
      message: `Grupo ${chatId} vinculado com sucesso como Painel Oficial!`,
      officeGroupChatId: chatId,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
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
