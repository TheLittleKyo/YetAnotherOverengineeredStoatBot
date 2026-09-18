/**
 * Helpers for reading ids off a Stoat server member.
 *
 * Member payloads arrive from three places — the gateway, the REST API and the
 * stoatbot.js cache — and each spells the same two ids differently
 * (`{ id: { server, user } }`, `{ _id: { … } }`, `serverId` / `server_id`, …).
 * Roles are just as inconsistent: an array of ids, an array of role objects, a
 * Set, or a Map keyed by id.
 *
 * Five modules carried near-identical copies of this normalization; they share
 * these two functions now.
 */

/**
 * Pull `{ serverId, userId }` off any member-ish payload, or null when either
 * is missing. Every candidate is type-checked: a non-string id (a nested user
 * object, say) is skipped rather than returned, because callers interpolate
 * these straight into API paths.
 */
export function getMemberIds(value: any, fallbackServerId?: string): { serverId: string; userId: string } | null {
  if (!value) return null;

  const serverId =
    (typeof value?.serverId === 'string' && value.serverId) ||
    (typeof value?.server_id === 'string' && value.server_id) ||
    (typeof value?.id?.server === 'string' && value.id.server) ||
    (typeof value?._id?.server === 'string' && value._id.server) ||
    fallbackServerId ||
    null;

  const userId =
    (typeof value?.id?.user === 'string' && value.id.user) ||
    (typeof value?._id?.user === 'string' && value._id.user) ||
    (typeof value?.userId === 'string' && value.userId) ||
    (typeof value?.user_id === 'string' && value.user_id) ||
    (typeof value?.user === 'string' && value.user) ||
    (typeof value?.id === 'string' && value.id) ||
    (typeof value?._id === 'string' && value._id) ||
    null;

  if (!serverId || !userId) return null;

  return { serverId, userId };
}

/** Flatten a member's `roles` — array, Set or Map, of ids or objects — to ids. */
export function getRoleIds(roles: unknown): string[] {
  if (!roles) return [];

  if (Array.isArray(roles)) {
    return roles
      .map((role) => {
        if (typeof role === 'string') return role;
        if (role && typeof role === 'object') return (role as any).id || (role as any)._id || null;
        return null;
      })
      .filter((id): id is string => !!id);
  }

  if (roles instanceof Set) return Array.from(roles).filter((id): id is string => typeof id === 'string');
  if (roles instanceof Map) return Array.from(roles.keys()).filter((id): id is string => typeof id === 'string');

  return [];
}
