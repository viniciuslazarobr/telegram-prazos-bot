import { createClient } from '@supabase/supabase-js';
import { config } from './config';

export interface TeamMember {
  telegram_user_id: string;
  name: string;
  username: string | null;
  created_at: string;
}

export interface Process {
  id: number;
  process_number: string;
  client_name: string;
  deadline_info: string;
  owner_telegram_id: string;
  owner_name: string;
  due_date: string; // YYYY-MM-DD
  remind_days_before: number;
  status: 'PENDENTE' | 'CONCLUIDO' | 'CANCELADO';
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface AppSettings {
  key: string;
  value: string;
}

// Inicialização do cliente Supabase com chave de serviço (Service Role)
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

/**
 * ID padrão conhecido do grupo do escritório (extraído dos logs do Telegram)
 */
export const DEFAULT_OFFICE_GROUP_ID = '-1003976237316';

/**
 * Obtém a data de hoje no fuso horário configurado no formato YYYY-MM-DD
 */
export function getTodayDateString(timezone: string = config.timezone): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date()); // Retorna "YYYY-MM-DD"
}

/**
 * Calcula a diferença em dias corridos entre a data atual de São Paulo e a data de vencimento.
 */
export function calculateDaysRemaining(dueDateStr: string, timezone: string = config.timezone): number {
  const todayStr = getTodayDateString(timezone);
  const [tY, tM, tD] = todayStr.split('-').map(Number);
  const [dY, dM, dD] = dueDateStr.split('-').map(Number);

  const todayUtc = Date.UTC(tY, tM - 1, tD);
  const dueUtc = Date.UTC(dY, dM - 1, dD);

  const diffMs = dueUtc - todayUtc;
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Converte data YYYY-MM-DD para DD/MM/AAAA
 */
export function formatDateBR(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

/**
 * Converte data DD/MM/AAAA para YYYY-MM-DD
 */
export function parseDateBRToISO(brDateStr: string): string | null {
  const match = brDateStr.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!match) return null;
  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  const year = match[3];

  const dNum = parseInt(day, 10);
  const mNum = parseInt(month, 10);
  if (dNum < 1 || dNum > 31 || mNum < 1 || mNum > 12) return null;

  return `${year}-${month}-${day}`;
}

// ==========================================
// OPERAÇÕES: MEMBROS DA EQUIPE
// ==========================================

export async function upsertTeamMember(
  telegramUserId: string | number,
  name: string,
  username?: string | null
): Promise<TeamMember> {
  const idStr = String(telegramUserId);
  const { data, error } = await supabase
    .from('team_members')
    .upsert(
      {
        telegram_user_id: idStr,
        name: name.trim(),
        username: username || null,
      },
      { onConflict: 'telegram_user_id' }
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Falha ao registrar membro da equipe: ${error.message}`);
  }

  // Vincula retroativamente prazos pendentes atribuídos com este nome
  await linkUnassignedProcessesToMember(idStr, name);

  return data as TeamMember;
}

/**
 * Vincula retroativamente prazos que foram cadastrados previamente com o nome do membro
 */

/**
 * Normaliza um nome para comparação flexível (remove acentos, pontuação e títulos como Dr./Dra.)
 */
export function normalizePersonName(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/\b(dr|dra|doutor|doutora|adv|advogado|advogada|sr|sra)\b\.?/gi, '') // remove títulos
    .replace(/[^a-z0-9\s]/g, '') // remove pontuação
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compara se dois nomes se referem à mesma pessoa com inteligência jurídica e apelidos
 */
export function doPersonNamesMatch(name1: string, name2: string): boolean {
  const n1 = normalizePersonName(name1);
  const n2 = normalizePersonName(name2);
  if (!n1 || !n2) return false;
  if (n1 === n2 || n1.includes(n2) || n2.includes(n1)) return true;

  // Compara tokens individuais (primeiro nome, sobrenome) com comprimento >= 3
  const words1 = n1.split(' ').filter((w) => w.length >= 3);
  const words2 = n2.split(' ').filter((w) => w.length >= 3);
  return words1.some((w) => words2.includes(w));
}

export async function linkUnassignedProcessesToMember(
  telegramUserId: string | number,
  memberName: string
): Promise<number> {
  try {
    const idStr = String(telegramUserId);
    if (!memberName || !memberName.trim()) return 0;

    const { data: unassigned, error: fetchErr } = await supabase
      .from('processes')
      .select('id, owner_name, owner_telegram_id')
      .eq('status', 'PENDENTE')
      .like('owner_telegram_id', 'unassigned_%');

    if (fetchErr || !unassigned || unassigned.length === 0) return 0;

    const toUpdateIds: number[] = [];
    for (const proc of unassigned) {
      if (doPersonNamesMatch(proc.owner_name || '', memberName)) {
        toUpdateIds.push(proc.id);
      }
    }

    if (toUpdateIds.length > 0) {
      await supabase
        .from('processes')
        .update({ owner_telegram_id: idStr, owner_name: memberName.trim() })
        .in('id', toUpdateIds);
    }

    return toUpdateIds.length;
  } catch (err) {
    console.error('Erro ao vincular prazos pendentes não atribuídos:', err);
    return 0;
  }
}

export async function updateTeamMemberName(
  telegramUserId: string | number,
  newName: string
): Promise<{ member: TeamMember; linkedCount: number }> {
  const idStr = String(telegramUserId);
  const { data, error } = await supabase
    .from('team_members')
    .update({ name: newName.trim() })
    .eq('telegram_user_id', idStr)
    .select()
    .single();

  if (error) {
    throw new Error(`Falha ao atualizar nome do membro: ${error.message}`);
  }

  // Atualiza também os prazos pendentes desse membro para manter consistência visual
  await supabase
    .from('processes')
    .update({ owner_name: newName.trim() })
    .eq('owner_telegram_id', idStr)
    .eq('status', 'PENDENTE');

  // Vincula retroativamente processos que estavam como unassigned com esse novo apelido
  const linkedCount = await linkUnassignedProcessesToMember(idStr, newName);

  return { member: data as TeamMember, linkedCount };
}

export async function getTeamMember(
  telegramUserId: string | number
): Promise<TeamMember | null> {
  const idStr = String(telegramUserId);
  const { data, error } = await supabase
    .from('team_members')
    .select('*')
    .eq('telegram_user_id', idStr)
    .maybeSingle();

  if (error) {
    console.error(`Erro ao buscar membro ${idStr}:`, error);
    return null;
  }
  return (data as TeamMember) || null;
}

export async function getAllTeamMembers(): Promise<TeamMember[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    console.error('Erro ao buscar todos os membros:', error);
    return [];
  }
  return (data as TeamMember[]) || [];
}

// ==========================================
// OPERAÇÕES: CONFIGURAÇÕES (APP_SETTINGS)
// ==========================================

export async function getSetting(key: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error || !data) return null;
    const val = data.value?.trim();
    return val && val.length > 0 ? val : null;
  } catch (err) {
    return null;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  const cleanVal = String(value).trim();

  // 1. Tenta Upsert
  const { error: upsertError } = await supabase
    .from('app_settings')
    .upsert({ key, value: cleanVal }, { onConflict: 'key' });

  if (!upsertError) return;

  // 2. Fallback: Update
  const { data: updateData, error: updateError } = await supabase
    .from('app_settings')
    .update({ value: cleanVal })
    .eq('key', key)
    .select();

  if (!updateError && updateData && updateData.length > 0) return;

  // 3. Fallback: Insert
  const { error: insertError } = await supabase
    .from('app_settings')
    .insert({ key, value: cleanVal });

  if (insertError) {
    throw new Error(`Falha ao salvar configuração [${key}]: ${insertError.message}`);
  }
}

export async function getOfficeGroupChatId(): Promise<string | null> {
  const saved = await getSetting('office_group_chat_id');
  if (saved && saved.length > 0) return saved;

  // Se ainda não salvo, retorna o ID detectado do grupo da equipe como padrão seguro
  return DEFAULT_OFFICE_GROUP_ID;
}

export async function setOfficeGroupChatId(chatId: string | number): Promise<void> {
  await setSetting('office_group_chat_id', String(chatId).trim());
}

// ==========================================
// OPERAÇÕES: PROCESSOS E PRAZOS
// ==========================================

export interface CreateProcessDTO {
  process_number: string;
  client_name: string;
  deadline_info: string;
  owner_telegram_id: string | number;
  owner_name: string;
  due_date: string; // YYYY-MM-DD
  remind_days_before?: number;
}

export async function createProcess(dto: CreateProcessDTO): Promise<Process> {
  const { data, error } = await supabase
    .from('processes')
    .insert({
      process_number: dto.process_number.trim(),
      client_name: dto.client_name.trim(),
      deadline_info: dto.deadline_info.trim(),
      owner_telegram_id: String(dto.owner_telegram_id),
      owner_name: dto.owner_name.trim(),
      due_date: dto.due_date,
      remind_days_before: dto.remind_days_before ?? 3,
      status: 'PENDENTE',
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Falha ao cadastrar processo: ${error.message}`);
  }
  return data as Process;
}

export async function getProcessById(id: number): Promise<Process | null> {
  const { data, error } = await supabase
    .from('processes')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) return null;
  return data as Process;
}

export async function getMyPendingProcesses(
  ownerTelegramId: string | number,
  ownerName?: string
): Promise<Process[]> {
  const idStr = String(ownerTelegramId);

  // Auto-vincula prazos pendentes não atribuídos antes de listar
  if (ownerName && ownerName.trim()) {
    await linkUnassignedProcessesToMember(idStr, ownerName);
  }

  const { data, error } = await supabase
    .from('processes')
    .select('*')
    .eq('owner_telegram_id', idStr)
    .eq('status', 'PENDENTE')
    .order('due_date', { ascending: true });

  if (error) {
    console.error('Erro ao buscar meus processos pendentes:', error);
    return [];
  }
  return (data as Process[]) || [];
}

export async function getAllPendingProcesses(): Promise<Process[]> {
  const { data, error } = await supabase
    .from('processes')
    .select('*')
    .eq('status', 'PENDENTE')
    .order('due_date', { ascending: true });

  if (error) {
    console.error('Erro ao buscar processos pendentes do escritório:', error);
    return [];
  }
  return (data as Process[]) || [];
}

export async function completeProcess(
  id: number,
  completedBy: string
): Promise<Process | null> {
  const { data, error } = await supabase
    .from('processes')
    .update({
      status: 'CONCLUIDO',
      completed_by: completedBy.trim(),
      completed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error(`Erro ao concluir processo ${id}:`, error);
    return null;
  }
  return data as Process;
}

export async function cancelProcess(id: number): Promise<Process | null> {
  const { data, error } = await supabase
    .from('processes')
    .update({
      status: 'CANCELADO',
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error(`Erro ao cancelar processo ${id}:`, error);
    return null;
  }
  return data as Process;
}
