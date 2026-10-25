import cron from 'node-cron';
import { Bot, InlineKeyboard } from 'grammy';
import {
  getAllPendingProcesses,
  getOfficeGroupChatId,
  calculateDaysRemaining,
  formatDateBR,
  getTodayDateString,
  Process,
  DEFAULT_OFFICE_GROUP_ID,
} from './supabase';
import { config } from './config';
import { logEvent } from './server';

export interface AlertExecutionResult {
  totalProcessesChecked: number;
  alertedCount: number;
  privateMessagesSent: number;
  groupNotified: boolean;
  isUrgentOnly: boolean;
}

/**
 * Escapa caracteres reservados do Markdown do Telegram
 */
function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([_*`\[\]()])/g, '\\$1');
}

/**
 * Retorna o cabeçalho/status visual de urgência
 */
export function getUrgencyBadge(daysRemaining: number): { label: string; tag: string; emoji: string } {
  if (daysRemaining < 0) {
    const daysLate = Math.abs(daysRemaining);
    return {
      label: `🚨 ATRASADO há ${daysLate} dia${daysLate > 1 ? 's' : ''}!`,
      tag: 'ATRASADO',
      emoji: '🚨',
    };
  }
  if (daysRemaining === 0) {
    return {
      label: '⚠️ VENCE HOJE!',
      tag: 'HOJE',
      emoji: '⚠️',
    };
  }
  if (daysRemaining === 1) {
    return {
      label: '⏳ VENCE AMANHÃ!',
      tag: 'AMANHÃ',
      emoji: '⏳',
    };
  }
  return {
    label: `📅 Vence em ${daysRemaining} dias`,
    tag: `${daysRemaining}d`,
    emoji: '📅',
  };
}

/**
 * Executa a rotina de verificação de prazos e disparos (Individual e no Grupo Geral)
 */
export async function executeDeadlineCheck(
  bot: Bot,
  options: { isUrgentOnly?: boolean; manualTrigger?: boolean } = {}
): Promise<AlertExecutionResult> {
  const isUrgentOnly = !!options.isUrgentOnly;
  const isManual = !!options.manualTrigger;

  console.log(
    `[CRON] Iniciando verificação de prazos (urgenteApenas=${isUrgentOnly}, manual=${isManual})...`
  );

  const pendingProcesses = await getAllPendingProcesses();
  const alertableProcesses: Array<{ process: Process; daysRemaining: number }> = [];

  for (const proc of pendingProcesses) {
    const daysRemaining = calculateDaysRemaining(proc.due_date);

    if (isUrgentOnly) {
      if (daysRemaining <= 1) {
        alertableProcesses.push({ process: proc, daysRemaining });
      }
    } else {
      if (daysRemaining <= proc.remind_days_before) {
        alertableProcesses.push({ process: proc, daysRemaining });
      }
    }
  }

  let privateMessagesSent = 0;

  // 1. DISPAROS INDIVIDUAIS NO PRIVADO DE CADA RESPONSÁVEL
  for (const item of alertableProcesses) {
    const { process: proc, daysRemaining } = item;
    const badge = getUrgencyBadge(daysRemaining);

    const keyboard = new InlineKeyboard().text('✅ Concluir Prazo', `done:${proc.id}`);

    const messageText =
      `${badge.emoji} *LEMBRETE DE PRAZO PROCESSUAL*\n\n` +
      `*Status:* ${badge.label}\n` +
      `📂 *Processo:* \`${escapeMarkdown(proc.process_number)}\`\n` +
      `👤 *Cliente:* ${escapeMarkdown(proc.client_name)}\n` +
      `⏳ *Prazo:* ${escapeMarkdown(proc.deadline_info)}\n` +
      `📅 *Vencimento:* ${formatDateBR(proc.due_date)}\n\n` +
      `_Clique abaixo quando concluir a peça/ato para parar as notificações e avisar a equipe:_`;

    try {
      if (!proc.owner_telegram_id.startsWith('unassigned_')) {
        await bot.api.sendMessage(proc.owner_telegram_id, messageText, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        privateMessagesSent++;
      }
    } catch (err: any) {
      console.warn(
        `[CRON] Falha ao enviar lembrete privado para o usuário ${proc.owner_telegram_id} (${proc.owner_name}):`,
        err?.message || err
      );
    }
  }

  // 2. DISPARO NO GRUPO GERAL DO ESCRITÓRIO
  let groupNotified = false;
  const officeGroupChatId = (await getOfficeGroupChatId()) || DEFAULT_OFFICE_GROUP_ID;

  if (officeGroupChatId) {
    if (alertableProcesses.length > 0) {
      const groupedByOwner = new Map<string, Array<{ process: Process; daysRemaining: number }>>();

      for (const item of alertableProcesses) {
        const ownerName = item.process.owner_name || 'Não identificado';
        if (!groupedByOwner.has(ownerName)) {
          groupedByOwner.set(ownerName, []);
        }
        groupedByOwner.get(ownerName)!.push(item);
      }

      const todayStrBR = formatDateBR(getTodayDateString());
      const titlePrefix = isUrgentOnly
        ? '⚡ *PAINEL DE COBRANÇA URGENTE DO ESCRITÓRIO*'
        : '☀️ *PAINEL DO DIA DA EQUIPE - PRAZOS DO ESCRITÓRIO*';

      let groupMessage = `${titlePrefix}\n📅 Data: ${todayStrBR} | Horário de Brasília\n\n`;

      for (const [ownerName, items] of groupedByOwner.entries()) {
        groupMessage += `👤 *${escapeMarkdown(ownerName)}* (${items.length} prazo${items.length > 1 ? 's' : ''}):\n`;
        for (const { process: p, daysRemaining } of items) {
          const badge = getUrgencyBadge(daysRemaining);
          groupMessage +=
            `  • [${badge.tag}] Proc: \`${escapeMarkdown(p.process_number)}\` | Cli: *${escapeMarkdown(p.client_name)}*\n` +
            `    Tarefa: _${escapeMarkdown(p.deadline_info)}_ (Vence: ${formatDateBR(p.due_date)})\n`;
        }
        groupMessage += '\n';
      }

      groupMessage += '👉 _Cada responsável já recebeu a notificação individual no privado com botão para dar baixa!_';

      try {
        await bot.api.sendMessage(officeGroupChatId, groupMessage, {
          parse_mode: 'Markdown',
        });
        groupNotified = true;
      } catch (err: any) {
        console.error('[CRON] Falha ao enviar painel no Grupo Geral do Escritório:', err?.message || err);
        logEvent('cron_group_send_error', { error: err.message, officeGroupChatId });
      }
    } else if (!isUrgentOnly || isManual) {
      const todayStrBR = formatDateBR(getTodayDateString());
      const cleanMessage =
        `☀️ *PAINEL DO ESCRITÓRIO - TUDO EM DIA!*\n📅 ${todayStrBR}\n\n` +
        `✅ Nenhum prazo pendente em período de alerta no momento. Ótimo trabalho equipe!`;

      try {
        await bot.api.sendMessage(officeGroupChatId, cleanMessage, {
          parse_mode: 'Markdown',
        });
        groupNotified = true;
      } catch (err: any) {
        console.error('[CRON] Falha ao enviar mensagem de status no grupo:', err?.message || err);
        logEvent('cron_group_send_error', { error: err.message, officeGroupChatId });
      }
    }
  }

  console.log(
    `[CRON] Verificação finalizada: ${alertableProcesses.length} prazos alertados, ${privateMessagesSent} mensagens privadas enviadas.`
  );

  return {
    totalProcessesChecked: pendingProcesses.length,
    alertedCount: alertableProcesses.length,
    privateMessagesSent,
    groupNotified,
    isUrgentOnly,
  };
}

/**
 * Inicializa todos os agendamentos automáticos com fuso horário America/Sao_Paulo
 */
export function setupCronJobs(bot: Bot): void {
  const timezone = config.timezone;

  // 1. 08:30 da manhã: Notificação Individual Completa + Painel do Dia no Grupo Geral
  cron.schedule(
    '30 8 * * *',
    async () => {
      console.log('[CRON-08:30] Executando rotina matinal de lembretes...');
      try {
        await executeDeadlineCheck(bot, { isUrgentOnly: false });
      } catch (err) {
        console.error('[CRON-08:30] Erro ao executar rotina matinal:', err);
      }
    },
    { timezone }
  );

  // 2. 14:00: Cobrança Urgente da Tarde
  cron.schedule(
    '0 14 * * *',
    async () => {
      console.log('[CRON-14:00] Executando cobrança urgente da tarde...');
      try {
        await executeDeadlineCheck(bot, { isUrgentOnly: true });
      } catch (err) {
        console.error('[CRON-14:00] Erro ao executar cobrança das 14h:', err);
      }
    },
    { timezone }
  );

  // 3. 17:00: Cobrança Urgente de Fim de Expediente
  cron.schedule(
    '0 17 * * *',
    async () => {
      console.log('[CRON-17:00] Executando cobrança urgente de fim de expediente...');
      try {
        await executeDeadlineCheck(bot, { isUrgentOnly: true });
      } catch (err) {
        console.error('[CRON-17:00] Erro ao executar cobrança das 17h:', err);
      }
    },
    { timezone }
  );

  console.log(`[CRON] Agendamentos configurados com sucesso no fuso horário ${timezone}:`);
  console.log(' - 08:30: Lembretes individuais + Painel do Dia da Equipe no Grupo');
  console.log(' - 14:00: Cobrança urgente (vence hoje, amanhã ou atrasados)');
  console.log(' - 17:00: Cobrança urgente de fim de expediente');
}
