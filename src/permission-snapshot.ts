/**
 * Ticket channel permission snapshots.
 *
 * Captures the channel's permission overrides (default + per-role) and the
 * effective view/read/send state of the ticket participants, so a transcript
 * can show what access existed *before the ticket was closed* and *at the time
 * the transcript was generated*.
 *
 * The snapshot is a plain JSON-safe object stored on the ticket record and/or
 * passed straight into the HTML transcript generator.
 */
import { config } from './config.js';
import { Permission } from './permissions.js';

type RawOverride = { a?: unknown; d?: unknown; allow?: unknown; deny?: unknown } | number | string | null | undefined;

export type PermTarget = {
  /** 'default' for the channel default, otherwise the role id. */
  id: string;
  name: string;
  allow: string[];
  deny: string[];
};

export type UserPermState = {
  userId: string;
  username: string;
  /** Role label describing why we captured this user (Creator / Closed by / …). */
  relation: string;
  roleNames: string[];
  hasSupportRole: boolean;
  hasTicketRole: boolean;
  /**
   * Effective access derived from the channel overrides that apply to this
   * user (channel default + the user's roles). This ignores server-level base
   * permissions and role ranking nuances, so it is a close approximation, not
   * a guarantee — labelled as such in the transcript.
   */
  canView: boolean;
  canRead: boolean;
  canSend: boolean;
};

export type PermissionSnapshot = {
  capturedAt: string;
  label: string;
  channelName: string;
  channelId: string;
  default: PermTarget;
  roles: PermTarget[];
  users: UserPermState[];
};

/** Permission bits we surface in transcripts, in display order. */
const DISPLAY_PERMISSIONS: Array<[string, bigint]> = [
  ['ViewChannel', Permission.ViewChannel],
  ['ReadMessageHistory', Permission.ReadMessageHistory],
  ['SendMessage', Permission.SendMessage],
  ['ManageMessages', Permission.ManageMessages],
  ['SendEmbeds', Permission.SendEmbeds],
  ['UploadFiles', Permission.UploadFiles],
  ['Masquerade', Permission.Masquerade],
  ['React', Permission.React],
  ['ManageChannel', Permission.ManageChannel],
  ['ManagePermissions', Permission.ManagePermissions],
  ['InviteOthers', Permission.InviteOthers],
  ['Connect', Permission.Connect],
  ['Speak', Permission.Speak],
];

function toBigInt(value: unknown): bigint {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.trim()) return BigInt(value.trim().split('.')[0]);
  } catch {
    // ignore
  }
  return 0n;
}

/** Decode a permission bitmask into the human-readable names we display. */
export function decodePermissionNames(mask: unknown): string[] {
  const bits = toBigInt(mask);
  const names: string[] = [];
  for (const [name, flag] of DISPLAY_PERMISSIONS) {
    if ((bits & flag) !== 0n) names.push(name);
  }
  return names;
}

function normalizeOverride(value: RawOverride): { allow: bigint; deny: bigint } {
  if (value === null || value === undefined) return { allow: 0n, deny: 0n };
  if (typeof value !== 'object') return { allow: toBigInt(value), deny: 0n };
  const allow = (value as any).a ?? (value as any).allow;
  const deny = (value as any).d ?? (value as any).deny;
  return { allow: toBigInt(allow), deny: toBigInt(deny) };
}

function toPermTarget(id: string, name: string, value: RawOverride): PermTarget {
  const { allow, deny } = normalizeOverride(value);
  return { id, name, allow: decodePermissionNames(allow), deny: decodePermissionNames(deny) };
}

function extractRoleIds(roles: unknown): string[] {
  if (!roles) return [];
  if (Array.isArray(roles)) {
    return roles
      .map((role) => (typeof role === 'string' ? role : role?.id || role?._id || null))
      .filter((id): id is string => !!id);
  }
  if (roles instanceof Set) return Array.from(roles).filter((r): r is string => typeof r === 'string');
  if (roles instanceof Map) return Array.from(roles.keys()).filter((r): r is string => typeof r === 'string');
  if (typeof roles === 'object') return Object.keys(roles as object);
  return [];
}

/** Read the channel's raw permission overrides (default + per-role). */
async function readChannelOverrides(client: any, channel: any): Promise<{
  default: RawOverride;
  roles: Record<string, RawOverride>;
}> {
  let raw: any = null;
  try {
    if (client?.api?.get && channel?.id) {
      raw = await client.api.get(`/channels/${channel.id}`);
    }
  } catch {
    raw = null;
  }

  const source = raw || channel || {};
  return {
    default: source.default_permissions ?? source.defaultPermissions ?? null,
    roles: source.role_permissions ?? source.rolePermissions ?? {},
  };
}

function resolveServer(client: any) {
  return client?.servers?.cache?.get?.(config.serverId) || null;
}

function buildRoleNameMap(server: any): Map<string, string> {
  const map = new Map<string, string>();
  const source = server?.roles?.cache || server?.roles;
  const roles = source instanceof Map
    ? Array.from(source.values())
    : Array.isArray(source)
      ? source
      : source && typeof source === 'object'
        ? Object.entries(source).map(([id, role]) => ({ id, ...(role as any) }))
        : [];
  for (const role of roles) {
    const id = role?.id || role?._id;
    if (id) map.set(id, String(role?.name || `role-${String(id).slice(0, 6)}`));
  }
  return map;
}

/**
 * Fold the channel overrides that apply to a user (default + their roles) to
 * approximate their effective allow bitmask on the channel.
 */
function effectiveMaskForRoles(
  defaultOverride: RawOverride,
  roleOverrides: Record<string, RawOverride>,
  userRoleIds: string[],
): bigint {
  let value = 0n;
  const apply = (ov: RawOverride) => {
    const { allow, deny } = normalizeOverride(ov);
    value = (value | allow) & ~deny;
  };
  apply(defaultOverride);
  for (const roleId of userRoleIds) {
    if (roleOverrides[roleId]) apply(roleOverrides[roleId]);
  }
  return value;
}

async function captureUser(
  server: any,
  overrides: { default: RawOverride; roles: Record<string, RawOverride> },
  roleNames: Map<string, string>,
  userId: string,
  username: string,
  relation: string,
): Promise<UserPermState | null> {
  if (!userId) return null;

  let member: any = server?.members?.cache?.get?.(userId) || null;
  if (!member && server?.members?.fetch) {
    member = await server.members.fetch(userId).catch(() => null);
  }

  const roleIds = extractRoleIds(member?.roles);
  const mask = effectiveMaskForRoles(overrides.default, overrides.roles, roleIds);
  const names = decodePermissionNames(mask);
  const ticketRoleName = roleIds.map((id) => roleNames.get(id) || '').find((n) => /^ticketrole-/i.test(n)) || '';

  return {
    userId,
    username: username || member?.nickname || member?.user?.username || 'Unknown User',
    relation,
    roleNames: roleIds.map((id) => roleNames.get(id) || `role-${id.slice(0, 6)}`),
    hasSupportRole: config.supportRoleId ? roleIds.includes(config.supportRoleId) : false,
    hasTicketRole: !!ticketRoleName,
    canView: names.includes('ViewChannel'),
    canRead: names.includes('ReadMessageHistory'),
    canSend: names.includes('SendMessage'),
  };
}

/**
 * Capture a full permission snapshot for a ticket channel.
 * Never throws — returns a best-effort snapshot with whatever could be read.
 */
export async function captureTicketPermissionSnapshot(
  client: any,
  channel: any,
  ticket: any,
  label: string,
): Promise<PermissionSnapshot> {
  const server = resolveServer(client);
  const roleNames = server ? buildRoleNameMap(server) : new Map<string, string>();
  const overrides = await readChannelOverrides(client, channel).catch(() => ({ default: null, roles: {} as Record<string, RawOverride> }));

  const roles: PermTarget[] = Object.entries(overrides.roles || {})
    .map(([roleId, ov]) => toPermTarget(roleId, roleNames.get(roleId) || `role-${roleId.slice(0, 6)}`, ov))
    .filter((t) => t.allow.length > 0 || t.deny.length > 0);

  const participants: Array<{ id?: string; name?: string; relation: string }> = [
    { id: ticket?.creatorId, name: ticket?.creatorUsername, relation: 'Ticket creator' },
    { id: ticket?.closedBy, name: ticket?.closedByUsername, relation: 'Closed by' },
  ];

  const seen = new Set<string>();
  const users: UserPermState[] = [];
  for (const p of participants) {
    if (!p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    const state = await captureUser(server, overrides, roleNames, p.id, p.name || '', p.relation).catch(() => null);
    if (state) users.push(state);
  }

  return {
    capturedAt: new Date().toISOString(),
    label,
    channelName: String(channel?.name || `ticket-${ticket?.ticketId || 'unknown'}`),
    channelId: String(channel?.id || ticket?.channelId || ''),
    default: toPermTarget('default', 'Channel default (@everyone)', overrides.default),
    roles,
    users,
  };
}
