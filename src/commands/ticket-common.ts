import { config } from '../config.js';
import { isTicketStaff } from '../permissions.js';

/**
 * Shared helpers for ticket subcommands that need to gate on support-staff
 * status inside a ticket channel (claim, priority, …). Mirrors the member
 * lookup ticket-close uses so behavior stays consistent.
 */
export async function resolveTicketActor(
  client: any,
  message: any,
): Promise<{ member: any; isStaff: boolean }> {
  let server: any = null;
  try {
    server = await client.servers.fetch(config.serverId);
  } catch {
    server = client.servers.cache.get(config.serverId);
  }

  const member = await server?.members
    ?.fetch(message.authorId)
    .catch(() => server?.members?.cache?.get?.(message.authorId) || null);

  const isStaff = await isTicketStaff(client, config.serverId, message.authorId, member, config.supportRoleId);
  return { member, isStaff };
}

/** Ticket priority levels, lowest → highest, with display metadata. */
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const PRIORITY_META: Record<TicketPriority, { label: string; icon: string }> = {
  low: { label: 'Low', icon: '🟢' },
  normal: { label: 'Normal', icon: '🔵' },
  high: { label: 'High', icon: '🟠' },
  urgent: { label: 'Urgent', icon: '🔴' },
};

export function normalizePriority(value: string | undefined): TicketPriority | null {
  const v = String(value || '').trim().toLowerCase();
  return (TICKET_PRIORITIES as readonly string[]).includes(v) ? (v as TicketPriority) : null;
}
