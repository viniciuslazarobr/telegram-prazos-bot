import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config';
import {
  upsertTeamMember,
  updateTeamMemberName,
  getTeamMember,
  getOfficeGroupChatId,
  setOfficeGroupChatId,
  createProcess,
  getMyPendingProcesses,
  getAllPendingProcesses,
  getProcessById,
  completeProcess,
  cancelProcess,
  formatDateBR,
  parseDateBRToISO,
  calculateDaysRemaining,
  Process,
  DEFAULT_OFFICE_GROUP_ID,
  getTodayDateString,
  getAllTeamMembers,
  doPersonNamesMatch,
  normalizePersonName,
  supabase,
} from './supabase';
import { parseDeadlineFromText, parseDeadlineFromAudio } from './ai';
import { executeDeadlineCheck, getUrgencyBadge } from './cron';
import { logEvent } from './server';

// Criação da instância do Bot
export const bot = new Bot(config.telegramBotToken);

/**
 * Middleware para registrar e diagnosticar eventos recebidos
 */
bot.use(async (ctx, next) => {
  const textPreview = ctx.message?.text || ctx.callbackQuery?.data || (ctx.message?.voice ? '[Audio]' : undefined);
  logEvent('telegram_update', {
    chatType: ctx.chat?.type,
    chatId: ctx.chat?.id,
    from: ctx.from?.first_name,
    fromId: ctx.from?.id,
    text: textPreview,
  });
  await next();
});

/**
 * Escapa caracteres reservados do Markdown do Telegram para evitar erros de parsing (400 Bad Request)
 */
export function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([_*`\[\]()])/g, '\\$1');
}

/**
 * Garante que o usuário que enviou a mensagem está registrado no Supabase
 */
async function ensureUserRegistered(ctx: any): Promise<{ id: string; name: string }> {
  const from = ctx.from;
  if (!from) {
    return { id: '0', name: 'Usuário Desconhecido' };
  }

  const userId = String(from.id);
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || `Usuário ${userId}`;

  try {
    const existing = await getTeamMember(userId);
    if (existing) {
      return { id: userId, name: existing.name };
    }

    const saved = await upsertTeamMember(userId, fullName, from.username || null);
    return { id: userId, name: saved.name };
  } catch (err: any) {
    console.warn(`[ensureUserRegistered] Aviso: Banco de dados inacessível ou tabelas não criadas (${err.message})`);
    return { id: userId, name: fullName };
  }
}

/**
 * Localiza o responsável entre os membros da equipe cadastrados, ou mantém o nome especificado
 */
async function resolveOwner(
  responsibleName: string | undefined | null,
  creator: { id: string; name: string }
): Promise<{ id: string; name: string }> {
  if (!responsibleName || !responsibleName.trim()) {
    return creator;
  }

  const cleanResp = responsibleName.trim();

  // Se o responsável indicado for o próprio criador
  if (
    doPersonNamesMatch(cleanResp, creator.name) ||
    /^(eu|mim|meu|minha)$/i.test(cleanResp)
  ) {
    return creator;
  }

  // Busca membros da equipe já cadastrados no Supabase
  const members = await getAllTeamMembers();

  // 1. Tenta correspondência flexível entre os membros cadastrados (ex: "Carlos" bate em "Dr. Carlos Eduardo")
  const matched = members.find((m) => doPersonNamesMatch(cleanResp, m.name));
  if (matched) {
    return { id: matched.telegram_user_id, name: matched.name };
  }

  // 2. Se o responsável ainda não tiver entrado no bot (ex: Chefe ou Amigo ainda não deu /start),
  // geramos um identificador unassigned para salvar com o nome real indicado por Alexandre.
  // Assim que ele entrar no bot e der /start ou /nome, o sistema vincula retroativamente!
  const slug = normalizePersonName(cleanResp).replace(/[^a-z0-9]/g, '_') || 'responsavel';
  return {
    id: `unassigned_${slug}`,
    name: cleanResp,
  };
}

/**
 * Formata a linha de aviso de antecedência com inteligência contextual
 */
function formatRemindNotice(daysRemaining: number, remindDaysBefore: number): string {
  if (daysRemaining < 0) {
    return '🚨 *Status:* Prazo já vencido / em atraso! Cobrança ativa.';
  }
  if (daysRemaining === 0) {
    return '⚡ *Status:* Prazo fatal para HOJE! Notificações ativas ao longo do dia.';
  }
  if (daysRemaining === 1) {
    return '⏳ *Status:* Vence amanhã! Cobrança urgente ativa.';
  }
  return `🔔 *Avisos:* Começa a alertar ${remindDaysBefore} dias antes do vencimento`;
}

/**
 * Envia notificação imediata no Grupo Geral do Escritório sobre novos cadastros
 */
async function notifyOfficeGroupNewProcess(proc: Process, creatorName: string): Promise<void> {
  const officeGroupChatId = (await getOfficeGroupChatId()) || DEFAULT_OFFICE_GROUP_ID;
  if (!officeGroupChatId) return;

  const daysRemaining = calculateDaysRemaining(proc.due_date);
  const isToday = daysRemaining <= 0;
  const isTomorrow = daysRemaining === 1;

  let title = `📢 *${escapeMarkdown(creatorName)} cadastrou um novo prazo:*`;
  let alertBanner = '';

  if (isToday) {
    title = `🚨 *URGENTE: NOVO PRAZO PARA HOJE! Cadastrado por ${escapeMarkdown(creatorName)}:*`;
    alertBanner = `\n⚡ *ATENÇÃO EQUIPE: ESTE PRAZO VENCE HOJE!*`;
  } else if (isTomorrow) {
    title = `⏳ *ATENÇÃO: PRAZO PARA AMANHÃ! Cadastrado por ${escapeMarkdown(creatorName)}:*`;
  }

  const noticeLine = formatRemindNotice(daysRemaining, proc.remind_days_before);

  const msg =
    `${title}\n\n` +
    `📂 *Processo:* \`${escapeMarkdown(proc.process_number)}\`\n` +
    `👤 *Cliente:* *${escapeMarkdown(proc.client_name)}*\n` +
    `⏳ *Prazo:* _${escapeMarkdown(proc.deadline_info)}_\n` +
    `📅 *Vencimento:* *${formatDateBR(proc.due_date)}*${alertBanner}\n` +
    `${noticeLine}\n` +
    `📌 *Responsável:* ${escapeMarkdown(proc.owner_name)}`;

  try {
    await bot.api.sendMessage(officeGroupChatId, msg, { parse_mode: 'Markdown' });
  } catch (err: any) {
    console.error('[BOT] Falha ao enviar notificação de novo prazo no Grupo Geral:', err?.message || err);
    logEvent('notify_group_error', { error: err.message, officeGroupChatId });
  }
}

/**
 * Envia notificação imediata no Grupo Geral do Escritório sobre prazos concluídos
 */
async function notifyOfficeGroupCompleted(proc: Process, completedByName: string): Promise<void> {
  const officeGroupChatId = (await getOfficeGroupChatId()) || DEFAULT_OFFICE_GROUP_ID;
  if (!officeGroupChatId) return;

  const msg =
    `✅ *${escapeMarkdown(completedByName)}* concluiu o prazo do Processo \`${escapeMarkdown(proc.process_number)}\`!\n\n` +
    `👤 *Cliente:* ${escapeMarkdown(proc.client_name)}\n` +
    `⏳ *Prazo:* ${escapeMarkdown(proc.deadline_info)}\n` +
    `📅 *Vencimento original:* ${formatDateBR(proc.due_date)}\n` +
    `🎉 _Lembretes automáticos deste prazo foram encerrados._`;

  try {
    await bot.api.sendMessage(officeGroupChatId, msg, { parse_mode: 'Markdown' });
  } catch (err: any) {
    console.error('[BOT] Falha ao enviar aviso de conclusão no Grupo Geral:', err?.message || err);
  }
}

// ==========================================
// AUTO-VINCULAÇÃO QUANDO O BOT É ADICIONADO AO GRUPO
// ==========================================

bot.on('my_chat_member', async (ctx) => {
  const status = ctx.myChatMember.new_chat_member.status;
  const chatType = ctx.chat.type;

  if ((chatType === 'group' || chatType === 'supergroup') && (status === 'member' || status === 'administrator')) {
    const chatId = String(ctx.chat.id);
    await setOfficeGroupChatId(chatId);
    try {
      await ctx.api.sendMessage(
        chatId,
        `✅ *Painel do Escritório Vinculado Automaticamente!*\n\n` +
        `Este grupo agora é o canal oficial de alertas e lembretes da equipe. Todos os prazos cadastrados e concluídos aparecerão aqui.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      // Ignora erro inicial
    }
  }
});

// ==========================================
// COMANDOS DO BOT
// ==========================================

/**
 * /start: Registro e apresentação do Bot
 */
bot.command('start', async (ctx) => {
  try {
    const user = await ensureUserRegistered(ctx);

    const welcome =
      `⚖️ *Bem-vindo(a) ao Bot de Prazos do Escritório!*\n\n` +
      `Olá, *${escapeMarkdown(user.name)}*! Seu usuário já está vinculado ao sistema.\n\n` +
      `📌 *Como funciona:*\n` +
      `1. Cada membro da equipe cadastra seus prazos por *áudio*, *texto livre* ou comando.\n` +
      `2. Nos horários de cobrança (08:30, 14:00 e 17:00), o Bot manda uma notificação privada para você com botão de dar baixa.\n` +
      `3. O *Grupo Geral do Escritório* recebe o resumo diário da equipe e avisos sempre que alguém cadastrar ou concluir um prazo.\n\n` +
      `🛠️ *Comandos Principais:*\n` +
      `• \`/meus\` - Ver seus prazos pendentes\n` +
      `• \`/geral\` - Ver os prazos de todos os 3 membros da equipe\n` +
      `• \`/hoje\` - Ver prazos de hoje, amanhã ou atrasados\n` +
      `• \`/novo [Nº] | [Cliente] | [Prazo] | [DD/MM/AAAA]\` - Cadastrar prazo\n` +
      `• \`/nome [Seu Apelido]\` - Mudar seu nome de exibição\n` +
      `• \`/definir_grupo\` - Definir o grupo atual como Painel do Escritório\n` +
      `• \`/teste_alerta\` - Disparar teste imediato dos lembretes\n` +
      `• \`/ajuda\` - Manual completo de uso\n\n` +
      `💡 *Dica:* Você pode simplesmente enviar um *áudio de voz* ou escrever: _"Processo 12345 do cliente Silva, contestação vence 15/11"_ que eu cadastro automaticamente!`;

    await ctx.reply(welcome, { parse_mode: 'Markdown' });
  } catch (err: any) {
    console.error('[START ERROR]', err);
    await ctx.reply(
      `⚠️ Erro ao iniciar: ${err.message}\n` +
      `Dica: Verifique se o script SQL (schema.sql) foi executado no painel do Supabase.`
    );
  }
});

/**
 * /nome [Apelido]: Altera o nome de exibição do membro
 */
bot.command('nome', async (ctx) => {
  const args = ctx.match?.trim();
  if (!args) {
    return ctx.reply(
      '⚠️ Por favor, informe seu nome após o comando.\nExemplo: `/nome Marcos` ou `/nome Chefe`',
      { parse_mode: 'Markdown' }
    );
  }

  const userId = String(ctx.from?.id);
  try {
    const { member: updated, linkedCount } = await updateTeamMemberName(userId, args);
    let linkedText = '';
    if (linkedCount > 0) {
      linkedText = `\n\n🎉 *Vinculamos ${linkedCount} prazo${linkedCount > 1 ? 's' : ''} pendente${linkedCount > 1 ? 's' : ''}* que já ${linkedCount > 1 ? 'estavam cadastrados' : 'estava cadastrado'} para você! Use \`/meus\` para visualizá-lo${linkedCount > 1 ? 's' : ''}.`;
    }

    await ctx.reply(
      `✅ Seu nome de exibição foi atualizado para: *${escapeMarkdown(updated.name)}*!${linkedText}\n\n` +
      `Ele será usado nas listagens, notificações privadas e avisos do escritório.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    await ctx.reply(
      `❌ Erro ao atualizar nome: ${err.message}`
    );
  }
});

/**
 * /definir_grupo (e atalhos /definir, /grupo_oficial)
 */
bot.command(['definir_grupo', 'definir', 'grupo_oficial'], async (ctx) => {
  const chatType = ctx.chat?.type;
  if (chatType !== 'group' && chatType !== 'supergroup') {
    return ctx.reply(
      '⚠️ Este comando deve ser executado **dentro do Grupo do Telegram do Escritório**.\n\n' +
      '💡 *Dica alternativa:* Você também pode simplesmente **encaminhar qualquer mensagem do grupo aqui para mim no privado**, que eu vinculo o grupo automaticamente!',
      { parse_mode: 'Markdown' }
    );
  }

  const chatId = String(ctx.chat.id);
  try {
    await setOfficeGroupChatId(chatId);
    await ctx.reply(
      `✅ *Este grupo agora é o Painel Geral Oficial do Escritório!*\n\n` +
      `📢 A partir de agora, todos os novos cadastros, baixas e o Painel do Dia às 08:30 serão enviados aqui para toda a equipe acompanhar.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Erro ao salvar grupo: ${err.message}`);
  }
});

/**
 * /grupo: Exibe o status da vinculação do grupo
 */
bot.command('grupo', async (ctx) => {
  const currentGroupId = await getOfficeGroupChatId();
  if (currentGroupId) {
    await ctx.reply(`ℹ️ O Grupo Geral do Escritório está configurado (Chat ID: \`${currentGroupId}\`).`, {
      parse_mode: 'Markdown',
    });
  } else {
    await ctx.reply(
      `⚠️ Nenhum Grupo Geral configurado ainda. Adicione o bot ao grupo do escritório e digite \`/definir_grupo\`.`,
      { parse_mode: 'Markdown' }
    );
  }
});

/**
 * /limpar_banco: Reseta a base de dados (processos e membros) mantendo o grupo do escritório
 */
bot.command(['limpar_banco', 'resetar_base'], async (ctx) => {
  try {
    const { error: pErr } = await supabase.from('processes').delete().neq('id', 0);
    const { error: mErr } = await supabase.from('team_members').delete().neq('telegram_user_id', '0');

    if (pErr || mErr) {
      return ctx.reply(`❌ Erro ao limpar base: ${pErr?.message || mErr?.message}`);
    }

    await ctx.reply(
      '🧹 *Base de Dados Limpa com Sucesso!*\n\n' +
      '• Todos os prazos e testes anteriores foram excluídos.\n' +
      '• O cadastro de membros foi zerado.\n' +
      '• O Grupo Geral do Escritório foi preservado.\n\n' +
      'Tudo pronto para começar do zero! Cada membro pode dar `/start` e `/nome [Nome Real]`.',
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Erro ao limpar base: ${err.message}`);
  }
});

/**
 * /novo [Nº] | [Cliente] | [Prazo] | [DD/MM/AAAA] [| Dias]
 */
bot.command('novo', async (ctx) => {
  const input = ctx.match?.trim();
  if (!input) {
    return ctx.reply(
      `⚠️ *Formato inválido!*\nUse:\n\`/novo [Nº Processo] | [Nome do Cliente] | [Prazo] | [DD/MM/AAAA]\`\n\n` +
      `*Exemplo:*\n\`/novo 123 | Ali | Vencimento às 13:30 | 25/10/2026\``,
      { parse_mode: 'Markdown' }
    );
  }

  const parts = input.split('|').map((s) => s.trim());
  if (parts.length < 4) {
    return ctx.reply(
      `⚠️ São necessários pelo menos 4 campos separados por barra vertical \`|\`:\n` +
      `\`/novo [Nº Processo] | [Nome do Cliente] | [Prazo] | [DD/MM/AAAA]\``,
      { parse_mode: 'Markdown' }
    );
  }

  const [processNumber, clientName, deadlineInfo, dateRaw, part5, part6] = parts;
  const isoDate = parseDateBRToISO(dateRaw);
  if (!isoDate) {
    return ctx.reply(
      `⚠️ Data inválida: *${escapeMarkdown(dateRaw)}*.\nPor favor, utilize o formato *DD/MM/AAAA* (ex: 25/10/2026).`,
      { parse_mode: 'Markdown' }
    );
  }

  let responsibleName: string | undefined = undefined;
  let remindDays = 3;

  if (part5) {
    const num = parseInt(part5, 10);
    if (isNaN(num)) {
      responsibleName = part5;
    } else {
      remindDays = num;
    }
  }

  if (part6) {
    const num = parseInt(part6, 10);
    if (isNaN(num)) {
      responsibleName = part6;
    } else {
      remindDays = num;
    }
  }

  const user = await ensureUserRegistered(ctx);
  const owner = await resolveOwner(responsibleName, user);

  try {
    const process = await createProcess({
      process_number: processNumber.replace(/[.,;:]+$/, '').trim(),
      client_name: clientName.replace(/[.,;:]+$/, '').trim(),
      deadline_info: deadlineInfo.trim(),
      owner_telegram_id: owner.id,
      owner_name: owner.name,
      due_date: isoDate,
      remind_days_before: isNaN(remindDays) ? 3 : remindDays,
    });

    const keyboard = new InlineKeyboard()
      .text('✅ Concluir Prazo', `done:${process.id}`)
      .text('🗑️ Excluir', `delete:${process.id}`);

    const daysRemaining = calculateDaysRemaining(process.due_date);
    const noticeLine = formatRemindNotice(daysRemaining, process.remind_days_before);

    await ctx.reply(
      `✅ *Prazo Cadastrado com Sucesso!*\n\n` +
      `📂 *Processo:* \`${escapeMarkdown(process.process_number)}\`\n` +
      `👤 *Cliente:* ${escapeMarkdown(process.client_name)}\n` +
      `⏳ *Prazo:* ${escapeMarkdown(process.deadline_info)}\n` +
      `📅 *Vencimento:* ${formatDateBR(process.due_date)}\n` +
      `${noticeLine}\n` +
      `📌 *Responsável:* ${escapeMarkdown(process.owner_name)}`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );

    await notifyOfficeGroupNewProcess(process, user.name);
  } catch (err: any) {
    logEvent('command_novo_error', { error: err.message });
    await ctx.reply(`❌ Erro ao cadastrar prazo: ${err.message}`);
  }
});

/**
 * /meus: Lista os prazos pendentes do usuário atual
 */
bot.command('meus', async (ctx) => {
  const user = await ensureUserRegistered(ctx);
  const myProcesses = await getMyPendingProcesses(user.id, user.name);

  if (myProcesses.length === 0) {
    return ctx.reply(`🎉 *Parabéns, ${escapeMarkdown(user.name)}!*\nVocê não possui nenhum prazo pendente no momento.`, {
      parse_mode: 'Markdown',
    });
  }

  let text = `📋 *SEUS PRAZOS PENDENTES (${myProcesses.length}):*\n\n`;

  for (const proc of myProcesses) {
    const daysRemaining = calculateDaysRemaining(proc.due_date);
    const badge = getUrgencyBadge(daysRemaining);

    text +=
      `${badge.emoji} *[${badge.tag}]* Proc: \`${escapeMarkdown(proc.process_number)}\`\n` +
      `👤 Cliente: *${escapeMarkdown(proc.client_name)}*\n` +
      `⏳ Prazo: _${escapeMarkdown(proc.deadline_info)}_\n` +
      `📅 Vencimento: *${formatDateBR(proc.due_date)}* (${badge.label})\n\n`;
  }

  const keyboard = new InlineKeyboard();
  myProcesses.forEach((proc, idx) => {
    keyboard.text(`✅ Concluir #${proc.id}`, `done:${proc.id}`);
    if ((idx + 1) % 2 === 0) keyboard.row();
  });

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
});

/**
 * /geral: Lista todos os prazos pendentes do escritório agrupados por membro
 */
bot.command('geral', async (ctx) => {
  const allProcesses = await getAllPendingProcesses();

  if (allProcesses.length === 0) {
    return ctx.reply('🎉 *O escritório está 100% em dia!*\nNenhum prazo pendente cadastrado.', {
      parse_mode: 'Markdown',
    });
  }

  const grouped = new Map<string, Process[]>();
  for (const proc of allProcesses) {
    const owner = proc.owner_name || 'Sem Responsável';
    if (!grouped.has(owner)) {
      grouped.set(owner, []);
    }
    grouped.get(owner)!.push(proc);
  }

  let text = `📊 *PAINEL GERAL DO ESCRITÓRIO - PRAZOS PENDENTES (${allProcesses.length})*\n\n`;

  for (const [ownerName, procs] of grouped.entries()) {
    text += `👤 *${escapeMarkdown(ownerName)}* (${procs.length} prazo${procs.length > 1 ? 's' : ''}):\n`;
    for (const p of procs) {
      const daysRemaining = calculateDaysRemaining(p.due_date);
      const badge = getUrgencyBadge(daysRemaining);
      text +=
        `  ${badge.emoji} \`${escapeMarkdown(p.process_number)}\` | *${escapeMarkdown(p.client_name)}*\n` +
        `     ↳ _${escapeMarkdown(p.deadline_info)}_ (Vence: *${formatDateBR(p.due_date)}* [${badge.tag}])\n`;
    }
    text += '\n';
  }

  text += `_Dica: Cada responsável pode concluir seus prazos usando /meus ou clicando no botão do lembrete._`;

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

/**
 * /hoje: Lista os prazos que vencem hoje, amanhã ou estão atrasados
 */
bot.command('hoje', async (ctx) => {
  const allProcesses = await getAllPendingProcesses();
  const urgent = allProcesses.filter((p) => calculateDaysRemaining(p.due_date) <= 1);

  if (urgent.length === 0) {
    return ctx.reply('✅ *Nenhum prazo urgente!*\nNão há prazos atrasados, vencendo hoje ou amanhã no escritório.', {
      parse_mode: 'Markdown',
    });
  }

  let text = `⚡ *PRAZOS URGENTES DO ESCRITÓRIO (${urgent.length})*\n\n`;

  for (const p of urgent) {
    const daysRemaining = calculateDaysRemaining(p.due_date);
    const badge = getUrgencyBadge(daysRemaining);

    text +=
      `${badge.emoji} *[${badge.tag}]* Responsável: *${escapeMarkdown(p.owner_name)}*\n` +
      `📂 Proc: \`${escapeMarkdown(p.process_number)}\` | Cliente: *${escapeMarkdown(p.client_name)}*\n` +
      `⏳ Prazo: _${escapeMarkdown(p.deadline_info)}_\n` +
      `📅 Vencimento: *${formatDateBR(p.due_date)}*\n\n`;
  }

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

/**
 * /teste_alerta: Dispara manualmente a rotina de notificações
 */
bot.command('teste_alerta', async (ctx) => {
  await ctx.reply('⏳ *Iniciando disparo de teste dos alertas...*', { parse_mode: 'Markdown' });

  try {
    const result = await executeDeadlineCheck(bot, { isUrgentOnly: false, manualTrigger: true });
    const replyText =
      `🚀 *Teste de Alerta Concluído!*\n\n` +
      `• *Total de processos pendentes checados:* ${result.totalProcessesChecked}\n` +
      `• *Prazos em período de alerta:* ${result.alertedCount}\n` +
      `• *Notificações enviadas no privado:* ${result.privateMessagesSent}\n` +
      `• *Painel enviado no Grupo Geral:* ${result.groupNotified ? '✅ Sim' : '❌ Não'}`;

    await ctx.reply(replyText, { parse_mode: 'Markdown' });
  } catch (err: any) {
    await ctx.reply(`❌ Falha ao executar teste de alerta: ${err.message}`);
  }
});

/**
 * /ajuda: Manual completo de ajuda
 */
bot.command('ajuda', async (ctx) => {
  const helpText =
    `📖 *MANUAL DO BOT DE PRAZOS DO ESCRITÓRIO*\n\n` +
    `🤖 *1. Como Cadastrar Prazos:*\n` +
    `• *Por Áudio:* Mande uma mensagem de voz no privado ou grupo dizendo: _"Processo 12345 cliente Silva, contestação para o Chefe vence hoje às 17h"_. A IA entenderá tudo!\n` +
    `• *Por Texto com Tags:*\n` +
    `\`Processo: 123\`\n` +
    `\`Cliente: Banco do Brasil\`\n` +
    `\`Prazo: Contestação às 13:55\`\n` +
    `\`Data: 25/10/2026\`\n` +
    `\`Responsável: Chefe\` _(ou Amigo, Alexandre)_\n` +
    `• *Por Linha Rápida (Pipes):*\n` +
    `\`123 | Banco do Brasil | Contestação | 25/10/2026 | Chefe\`\n` +
    `• *Por Comando:*\n` +
    `\`/novo 123 | Cliente | Prazo | DD/MM/AAAA | Responsável\`\n\n` +
    `👥 *2. Atribuição de Responsáveis:*\n` +
    `• Se você cadastrar para um colega (ex: Chefe ou Amigo), o bot atribui a ele automaticamente.\n` +
    `• Cada membro pode dar \`/nome [Apelido]\` (ex: \`/nome Chefe\`) para que o sistema vincule seus prazos ao seu Telegram!\n\n` +
    `📊 *3. Comandos de Consulta:*\n` +
    `• \`/meus\` - Mostra os seus próprios prazos pendentes com botões rápidos de baixa.\n` +
    `• \`/geral\` - Painel de todos os prazos do escritório agrupados por responsável.\n` +
    `• \`/hoje\` - Mostra os prazos urgentes (hoje, amanhã e atrasados).\n\n` +
    `⏰ *4. Horários das Notificações Automáticas:*\n` +
    `• *08:30:* Notificação individual no privado de cada responsável + Painel Geral no grupo do escritório.\n` +
    `• *14:00 e 17:00:* Cobrança urgente apenas para o que vence hoje, amanhã ou atrasados.\n` +
    `• *A cada 30min:* Alertas automáticos para prazos com horário marcado do dia.`;

  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// ==========================================
// CALLBACKS DOS BOTÕES INLINE
// ==========================================

bot.callbackQuery(/^done:(\d+)$/, async (ctx) => {
  const processId = parseInt(ctx.match[1], 10);
  const user = await ensureUserRegistered(ctx);

  try {
    const existing = await getProcessById(processId);
    if (!existing) {
      return ctx.answerCallbackQuery({ text: '⚠️ Prazo não encontrado.', show_alert: true });
    }

    if (existing.status === 'CONCLUIDO') {
      return ctx.answerCallbackQuery({
        text: `Este prazo já foi concluído por ${existing.completed_by || 'outro membro'}!`,
        show_alert: true,
      });
    }

    const updated = await completeProcess(processId, user.name);
    await ctx.answerCallbackQuery({ text: '✅ Prazo concluído com sucesso!' });

    const nowBR = new Date().toLocaleString('pt-BR', { timeZone: config.timezone });
    try {
      await ctx.editMessageText(
        `✅ *PRAZO CONCLUÍDO!*\n\n` +
        `📂 *Processo:* \`${escapeMarkdown(existing.process_number)}\`\n` +
        `👤 *Cliente:* ${escapeMarkdown(existing.client_name)}\n` +
        `⏳ *Prazo:* ${escapeMarkdown(existing.deadline_info)}\n` +
        `📅 *Vencimento:* ${formatDateBR(existing.due_date)}\n\n` +
        `🎉 Concluído por *${escapeMarkdown(user.name)}* em ${nowBR}.\n` +
        `_Lembretes automáticos encerrados._`,
        { parse_mode: 'Markdown' }
      );
    } catch (editErr) {
      // Ignora erro de edição
    }

    if (updated) {
      await notifyOfficeGroupCompleted(updated, user.name);
    }
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: `Erro: ${err.message}`, show_alert: true });
  }
});

bot.callbackQuery(/^delete:(\d+)$/, async (ctx) => {
  const processId = parseInt(ctx.match[1], 10);
  const user = await ensureUserRegistered(ctx);

  try {
    const existing = await getProcessById(processId);
    if (!existing) {
      return ctx.answerCallbackQuery({ text: '⚠️ Prazo não encontrado.', show_alert: true });
    }

    await cancelProcess(processId);
    await ctx.answerCallbackQuery({ text: '🗑️ Prazo excluído/cancelado.' });

    try {
      await ctx.editMessageText(
        `🗑️ *Prazo Cancelado/Excluído*\n` +
        `Processo \`${escapeMarkdown(existing.process_number)}\` (${escapeMarkdown(existing.client_name)}) cancelado por *${escapeMarkdown(user.name)}*.`,
        { parse_mode: 'Markdown' }
      );
    } catch (editErr) {
      // Ignora
    }
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: `Erro: ${err.message}`, show_alert: true });
  }
});

// ==========================================
// CAPTURA DE ÁUDIO / MENSAGENS DE VOZ
// ==========================================

bot.on(['message:voice', 'message:audio'], async (ctx) => {
  const user = await ensureUserRegistered(ctx);

  if (!config.geminiApiKey) {
    return ctx.reply(
      '⚠️ O processamento de áudio requer a chave `GEMINI_API_KEY` configurada no Render.\n' +
      'Por enquanto, utilize o comando `/novo [Nº] | [Cliente] | [Prazo] | [DD/MM/AAAA]`.',
      { parse_mode: 'Markdown' }
    );
  }

  const statusMsg = await ctx.reply('🎙️ *Ouvindo e analisando o áudio com IA...*', {
    parse_mode: 'Markdown',
  });

  try {
    const voiceOrAudio = ctx.message?.voice || ctx.message?.audio;
    if (!voiceOrAudio) throw new Error('Arquivo de áudio não detectado.');

    const file = await ctx.getFile();
    if (!file.file_path) throw new Error('Não foi possível obter o caminho do arquivo de áudio.');

    const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Falha ao baixar áudio: HTTP ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = voiceOrAudio.mime_type || 'audio/ogg';

    const parsed = await parseDeadlineFromAudio(buffer, mimeType);

    if (!parsed) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        '❌ Não consegui identificar os dados do processo no áudio.\n' +
        'Por favor, tente falar citando: *Número do processo*, *Nome do cliente*, *Qual o prazo* e *Data de vencimento*.'
      );
      return;
    }

    const owner = await resolveOwner(parsed.responsible_name, user);

    const process = await createProcess({
      process_number: parsed.process_number,
      client_name: parsed.client_name,
      deadline_info: parsed.deadline_info,
      owner_telegram_id: owner.id,
      owner_name: owner.name,
      due_date: parsed.due_date,
      remind_days_before: parsed.remind_days_before,
    });

    const keyboard = new InlineKeyboard()
      .text('✅ Concluir Prazo', `done:${process.id}`)
      .text('🗑️ Excluir', `delete:${process.id}`);

    const daysRemaining = calculateDaysRemaining(process.due_date);
    const noticeLine = formatRemindNotice(daysRemaining, process.remind_days_before);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `🎙️ *Prazo Extraído do Áudio com Sucesso!*\n\n` +
      `📂 *Processo:* \`${escapeMarkdown(process.process_number)}\`\n` +
      `👤 *Cliente:* ${escapeMarkdown(process.client_name)}\n` +
      `⏳ *Prazo:* ${escapeMarkdown(process.deadline_info)}\n` +
      `📅 *Vencimento:* ${formatDateBR(process.due_date)}\n` +
      `${noticeLine}\n` +
      `📌 *Responsável:* ${escapeMarkdown(process.owner_name)}`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );

    await notifyOfficeGroupNewProcess(process, user.name);
  } catch (err: any) {
    console.error('[AUDIO] Erro no processamento de áudio:', err);
    logEvent('audio_process_error', { error: err.message });
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `❌ Erro ao processar áudio: ${err.message}`
    );
  }
});

// ==========================================
// CAPTURA DE TEXTO LIVRE / LINGUAGEM NATURAL E ENCAMINHAMENTOS
// ==========================================

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  const isPrivate = ctx.chat.type === 'private';
  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

  // 1. SUPORTE A MENSAGEM ENCAMINHADA DO GRUPO PARA VINCULAÇÃO IMEDIATA
  const forwardFromChat = (ctx.message as any).forward_from_chat;
  const forwardOrigin = (ctx.message as any).forward_origin;
  const forwardedChat = forwardFromChat || (forwardOrigin && forwardOrigin.type === 'chat' ? forwardOrigin.chat : null);

  if (isPrivate && forwardedChat && (forwardedChat.type === 'group' || forwardedChat.type === 'supergroup')) {
    const targetChatId = String(forwardedChat.id);
    await setOfficeGroupChatId(targetChatId);
    return ctx.reply(
      `✅ *Grupo do Escritório Vinculado com Sucesso!*\n\n` +
      `Detectei que você encaminhou uma mensagem do grupo *${escapeMarkdown(forwardedChat.title || 'Escritório')}* (ID: \`${targetChatId}\`).\n` +
      `Ele agora está oficialmente registrado como o Painel Geral do Escritório! 🎉`,
      { parse_mode: 'Markdown' }
    );
  }

  // 2. SUPORTE A DEFINIR GRUPO POR TEXTO LIVRE NO GRUPO
  if (isGroup) {
    const lower = text.toLowerCase();
    if (lower.includes('definir_grupo') || lower.includes('definir grupo') || lower.includes('vincular grupo')) {
      const chatId = String(ctx.chat.id);
      await setOfficeGroupChatId(chatId);
      return ctx.reply(
        `✅ *Este grupo agora é o Painel Geral Oficial do Escritório!*\n\n` +
        `📢 A partir de agora, todos os novos cadastros, baixas e o Painel do Dia às 08:30 serão enviados aqui para toda a equipe acompanhar.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // Ignora mensagens que comecem com barra (comandos tratados separadamente)
  if (text.startsWith('/')) return;

  const startsWithPrazo = text.toLowerCase().startsWith('prazo:') || text.toLowerCase().startsWith('prazo') || text.toLowerCase().startsWith('processo');

  // Só processa se for no privado ou se no grupo começar com "prazo" ou "processo"
  if (!isPrivate && !startsWithPrazo) {
    return;
  }

  const user = await ensureUserRegistered(ctx);

  // Tenta interpretar com IA / regex
  const parsed = await parseDeadlineFromText(text);

  if (parsed) {
    try {
      const owner = await resolveOwner(parsed.responsible_name, user);

      const process = await createProcess({
        process_number: parsed.process_number,
        client_name: parsed.client_name,
        deadline_info: parsed.deadline_info,
        owner_telegram_id: owner.id,
        owner_name: owner.name,
        due_date: parsed.due_date,
        remind_days_before: parsed.remind_days_before,
      });

      const keyboard = new InlineKeyboard()
        .text('✅ Concluir Prazo', `done:${process.id}`)
        .text('🗑️ Excluir', `delete:${process.id}`);

      const daysRemaining = calculateDaysRemaining(process.due_date);
      const isToday = daysRemaining <= 0;
      const urgencyBadge = isToday ? ' 🚨 *[URGENTE: VENCE HOJE]*' : '';

      const noticeLine = formatRemindNotice(daysRemaining, process.remind_days_before);

      await ctx.reply(
        `✅ *Prazo Cadastrado com Sucesso!*${urgencyBadge}\n\n` +
        `📂 *Processo:* \`${escapeMarkdown(process.process_number)}\`\n` +
        `👤 *Cliente:* ${escapeMarkdown(process.client_name)}\n` +
        `⏳ *Prazo:* ${escapeMarkdown(process.deadline_info)}\n` +
        `📅 *Vencimento:* ${formatDateBR(process.due_date)}\n` +
        `${noticeLine}\n` +
        `📌 *Responsável:* ${escapeMarkdown(process.owner_name)}`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );

      // Notifica o grupo geral imediatamente com banner de urgência
      await notifyOfficeGroupNewProcess(process, user.name);
      return;
    } catch (err: any) {
      logEvent('create_process_text_error', { error: err.message, text });
      return ctx.reply(
        `❌ Não foi possível salvar o prazo no banco de dados.\n\n` +
        `*Motivo:* ${err.message}\n\n` +
        `Dica: Verifique se as tabelas do Supabase estão liberadas sem restrição de RLS.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // Se o usuário digitou no privado algo que não foi identificado
  if (isPrivate) {
    logEvent('text_unparsed', { text });
    await ctx.reply(
      `🤔 Não identifiquei todos os dados do prazo na sua mensagem.\n\n` +
      `Para cadastrar com sucesso, você pode:\n` +
      `1. Falar por *áudio de voz* 🎙️\n` +
      `2. Mandar o texto:\n` +
      `   _Processo: 123_\n` +
      `   _Cliente: Ali_\n` +
      `   _Prazo: Vencimento hoje às 13:30_\n` +
      `3. Ou usar o comando direto:\n` +
      `   \`/novo 123 | Ali | Vencimento hoje às 13:30 | ${formatDateBR(getTodayDateString())}\``,
      { parse_mode: 'Markdown' }
    );
  }
});

// Tratamento de erros do bot para que o processo nunca caia
bot.catch((err) => {
  console.error('[BOT ERROR] Erro capturado no ciclo de eventos do bot:', err);
  logEvent('bot_catch_error', { error: err.message });
});
