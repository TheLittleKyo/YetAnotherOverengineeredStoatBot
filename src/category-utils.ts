import { env } from './config.js';

type CategoryEditStrategy = 'auto' | 'bot' | 'session';
let categoryEditStrategy: CategoryEditStrategy = getSessionToken() ? 'session' : 'auto';

export function getReadableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return summarizeRawError(error);
  if (error && typeof error === 'object') {
    const anyErr = error as Record<string, unknown>;
    const msg = typeof anyErr.message === 'string' ? anyErr.message : null;
    if (msg) return summarizeRawError(msg);
    try {
      return summarizeRawError(JSON.stringify(error));
    } catch {
      return 'Unknown error';
    }
  }
  return String(error ?? 'Unknown error');
}

export async function moveChannelToCategory(
  client: any,
  serverId: string,
  channelId: string,
  categoryId: string,
) {
  const normalizedServerId = String(serverId || '').trim();
  const normalizedChannelId = String(channelId || '').trim();
  const normalizedCategoryId = String(categoryId || '').trim();

  if (!normalizedServerId) throw new Error('Missing server ID for category move.');
  if (!normalizedChannelId) throw new Error('Missing channel ID for category move.');
  if (!normalizedCategoryId) throw new Error('Missing category ID for category move.');

  // Prefer cache first to avoid extra network latency on every move.
  let server: any = client?.servers?.cache?.get?.(normalizedServerId) || null;
  if (!server) {
    try {
      server = await client.servers.fetch(normalizedServerId);
    } catch {
      server = null;
    }
  }

  if (!server) {
    throw new Error(`Server ${normalizedServerId} not found`);
  }

  const canManageServer = hasManageServerPermission(server?.me);
  if (canManageServer === false) {
    throw new Error('Bot is missing MANAGE_SERVER permission, so it cannot move channels between categories.');
  }

  const cachedCategories = Array.from(server?.categories?.values?.() || []);
  let categoriesSource: any[] = cachedCategories;

  // Only hit API if cache is empty or stale for requested target category.
  if (
    categoriesSource.length === 0 ||
    !categoriesSource.some((category: any) => category?.id === normalizedCategoryId)
  ) {
    try {
      const rawServer = await client.api.get(`/servers/${normalizedServerId}`, { include_channels: true });
      const rawCategories = Array.isArray(rawServer?.categories) ? rawServer.categories : [];
      if (rawCategories.length > 0) {
        categoriesSource = rawCategories;
      }
    } catch {
      // keep cache-derived categories
    }
  }

  if (categoriesSource.length === 0) {
    throw new Error(`Server ${normalizedServerId} has no categories configured`);
  }

  // Some API payloads may include a synthetic "default" category; do not edit it.
  const editableCategories = categoriesSource.filter((category: any) => category?.id && category.id !== 'default');

  const targetExists = editableCategories.some((c: any) => c?.id === normalizedCategoryId);
  if (!targetExists) {
    throw new Error(`Category ${normalizedCategoryId} not found on server`);
  }

  // Remove channel from every category first, then append it only to the target category.
  const updatedCategories = editableCategories.map((category: any) => {
    const channels = extractCategoryChannelIds(category).filter((id) => id !== normalizedChannelId);

    if (category?.id === normalizedCategoryId && !channels.includes(normalizedChannelId)) {
      channels.push(normalizedChannelId);
    }

    return {
      id: category?.id,
      title: category?.name || category?.title,
      channels,
    };
  });

  const sessionToken = getSessionToken();

  if (categoryEditStrategy === 'session' && sessionToken) {
    const sessionFirst = await trySessionTokenCategoryPatch(
      client,
      normalizedServerId,
      updatedCategories,
      sessionToken,
    );

    if (sessionFirst.ok) {
      return;
    }
  }

  try {
    // Server instance has no .edit(); edit is exposed via ServerManager.
    await client.servers.edit(normalizedServerId, { categories: updatedCategories });
    categoryEditStrategy = 'bot';
  } catch (error: any) {
    const detail = getReadableError(error);

    // Stoat API often restricts server category edits to session tokens.
    if (isAuthOrElevationFailure(detail) && sessionToken) {
      const sessionFallback = await trySessionTokenCategoryPatch(
        client,
        normalizedServerId,
        updatedCategories,
        sessionToken,
      );

      if (sessionFallback.ok) {
        categoryEditStrategy = 'session';
        return;
      }

      if (sessionFallback.reason) {
        throw new Error(
          `Server category editing failed for bot token (${detail}). ` +
          `Session-token fallback also failed: ${sessionFallback.reason}`
        );
      }
    }

    if (/401|unauthorized/i.test(detail)) {
      throw new Error(
        'Server category editing was rejected (Unauthorized). ' +
        'On Stoat this route is often session-token only, even if the bot role has all permissions.'
      );
    }

    if (/403|forbidden|notelevated/i.test(detail)) {
      throw new Error(
        'Server category editing was rejected (NotElevated/Forbidden). ' +
        'Your bot role may have all permissions but is not high enough in role hierarchy for this action.'
      );
    }

    throw new Error(`Failed to update server categories: ${detail}`);
  }
}

async function trySessionTokenCategoryPatch(
  client: any,
  serverId: string,
  categories: Array<{ id: string; title: string; channels: string[] }>,
  sessionToken: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!sessionToken) return { ok: false };

  const instanceUrl = String(client?.options?.rest?.instanceURL || 'https://api.stoat.chat').trim();
  const apiBase = isAbsoluteHttpUrl(instanceUrl) ? instanceUrl.replace(/\/+$/, '') : 'https://api.stoat.chat';

  try {
    const response = await fetch(`${apiBase}/servers/${serverId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken,
        'User-Agent': 'YetAnotherOverengineeredStoatBot/1.0.0',
      },
      body: JSON.stringify({ categories }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, reason: `HTTP ${response.status}${detail ? `: ${summarizeRawError(detail)}` : ''}` };
    }

    return { ok: true };
  } catch (error: any) {
    return { ok: false, reason: getReadableError(error) };
  }
}

function getSessionToken(): string {
  return env.sessionToken;
}

function isAuthOrElevationFailure(detail: string): boolean {
  return /401|403|unauthorized|forbidden|notelevated/i.test(detail);
}

function extractCategoryChannelIds(category: any): string[] {
  if (Array.isArray(category?.channels)) {
    return category.channels
      .map((entry: any) => (typeof entry === 'string' ? entry : entry?.id))
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
  }

  const fromChildren = Array.from(category?.children?.values?.() || [])
    .map((channel: any) => channel?.id)
    .filter((id: any): id is string => typeof id === 'string' && id.length > 0);

  if (fromChildren.length > 0) {
    return fromChildren;
  }

  if (Array.isArray(category?._children)) {
    return category._children.filter((id: any): id is string => typeof id === 'string' && id.length > 0);
  }

  return [];
}

function hasManageServerPermission(member: any): boolean | null {
  if (!member || typeof member.hasPermission !== 'function') return null;

  try {
    return !!member.hasPermission('MANAGE_SERVER');
  } catch {
    try {
      return !!member.hasPermission('ManageServer');
    } catch {
      return null;
    }
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function summarizeRawError(raw: string): string {
  if (!raw) return 'Unknown error';
  const h1 = raw.match(/<h1>\s*([^<]+)\s*<\/h1>/i);
  if (h1?.[1]) return h1[1].trim();
  const title = raw.match(/<title>\s*([^<]+)\s*<\/title>/i);
  if (title?.[1]) return title[1].trim();
  const trimmed = raw.trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}