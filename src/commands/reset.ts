import { createInterface } from 'readline';
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { Permission } from '../permissions.js';
import { requirePermissionInServer } from '../permissions.js';
import { normalizeMentionOrId } from '../id-utils.js';
import { sleep } from '../async-utils.js';
import { DATA_DIR, assertSafeDataDir, reloadAllDataFiles } from '../json-store.js';
import { wipeDatabase } from '../db.js';

const RESET_CONFIRM_TIMEOUT_MS = 60_000;
const DELETE_PACE_MS = 300;

// Only one pending reset at a time — prevents overlapping terminal prompts.
let pendingReset: {
  serverId: string;
  serverName: string;
  requestedBy: string;
  channelCount: number;
  roleCount: number;
  categoryCount: number;
} | null = null;

/**
 * !reset <serverID>
 *
 * Wipes a server completely: deletes every channel, every role (except the
 * default @everyone role which Stoat doesn't allow deleting), and clears all
 * local bot data.
 *
 * SAFETY: This command requires TWO confirmations:
 *   1. The caller must have Manage Server permission in the target server.
 *   2. The host terminal operator must type "yes" within 60 seconds.
 *
 * The terminal confirmation is the critical safety gate — even if a chat user
 * with Manage Server goes rogue, the reset cannot proceed without physical
 * access to the machine running the bot.
 */
export async function resetCommand(message, args, client) {
  const serverIdArg = String(args.shift() || '').trim();
  if (!serverIdArg) {
    await message.channel?.send({
      content: `❌ Usage: \`${config.prefix}reset <serverId>\`\nThis command deletes every channel and role in the server and clears all bot data. Requires terminal confirmation.`,
    });
    return;
  }

  const serverId = normalizeMentionOrId(serverIdArg);
  if (!serverId) {
    await message.channel?.send({ content: '❌ Invalid server ID.' });
    return;
  }

  // Gate 1: Manage Server permission IN THE TARGET SERVER. Checking the server
  // the command was typed in would let an admin of any server the bot joined
  // queue a wipe of a different server.
  if (!(await requirePermissionInServer(message, client, serverId, ['ManageServer'], 'Manage Server'))) return;

  // Resolve the server.
  let server = null;
  try {
    server = await client.servers.fetch(serverId);
  } catch {
    server = client.servers.cache.get(serverId);
  }
  if (!server) {
    await message.channel?.send({ content: `❌ Could not find server \`${serverId}\`. The bot must be a member of the server.` });
    return;
  }

  const serverName = String(server.name || serverId);
  const requesterId = message.authorId;
  const requesterName = message.author?.username || requesterId;

  // Pre-flight: check the bot's actual permissions in this server.
  // Stoat doesn't auto-create a bot role — bot permissions come from the
  // server's default_permissions + any roles explicitly assigned to the bot.
  const preflight = await checkBotPermissions(client, serverId);
  if (preflight.warnings.length > 0) {
    console.log('[reset] Bot permission pre-flight:');
    for (const w of preflight.warnings) console.log(`[reset]   ⚠️ ${w}`);
  }

  // Count what will be deleted.
  const channels: any[] = Array.from(server.channels?.cache?.values?.() || []);
  const roles: any[] = Array.from(server.roles?.cache?.values?.() || []);
  const categories: any[] = Array.from(server.categories?.values?.() || []);

  const channelCount = channels.length;
  const roleCount = roles.filter((r: any) => !isDefaultRole(r)).length;
  const categoryCount = categories.length;

  // Prevent overlapping resets.
  if (pendingReset) {
    await message.channel?.send({
      content: `❌ Another reset is already pending terminal confirmation for server "${pendingReset.serverName}". Wait for it to finish or time out, then try again.`,
    });
    return;
  }

  pendingReset = { serverId, serverName, requestedBy: requesterName, channelCount, roleCount, categoryCount };

  // Notify chat. Wrap in try/catch — the channel might deny Send Messages.
  const preflightNote = preflight.warnings.length > 0
    ? `\n\n⚠️ **Permission warnings:**\n${preflight.warnings.map((w: string) => `• ${w}`).join('\n')}\n\nSome channels/roles may fail to delete. See console for details.`
    : '';
  try {
    await message.channel?.send({
      content:
        `⚠️ **RESET REQUESTED**\n\n` +
        `**Server:** ${serverName} (\`${serverId}\`)\n` +
        `**Requested by:** ${requesterName} (\`${requesterId}\`)\n\n` +
        `This will delete:\n` +
        `• ${channelCount} channel(s)\n` +
        `• ${roleCount} role(s) (default @everyone is preserved)\n` +
        `• ${categoryCount} categor(ies)\n` +
        `• All local bot data (tickets, reaction-roles, welcome config, stats, logs, embeds)\n\n` +
        `⏳ Waiting for terminal confirmation on the host machine. The operator has ${RESET_CONFIRM_TIMEOUT_MS / 1000} seconds to type \`yes\`.` +
        preflightNote,
    });
  } catch (sendError: any) {
    console.warn(`[reset] Could not send initial chat notification: ${sendError?.message || sendError}`);
  }

  // Print prominent terminal prompt.
  printResetBanner(pendingReset);

  let confirmed = false;
  try {
    confirmed = await waitForTerminalConfirmation();
  } catch (error: any) {
    console.error('[reset] Terminal confirmation error:', error?.message || error);
  }

  if (!confirmed) {
    pendingReset = null;
    console.log('[reset] Confirmation denied or timed out. Reset cancelled.');
    await message.channel?.send({
      content: `❌ Reset cancelled — terminal confirmation was denied or timed out after ${RESET_CONFIRM_TIMEOUT_MS / 1000}s.`,
    });
    return;
  }

  // Capture the response channel ID before wiping — the chat channel we're
  // responding in will be deleted as part of the wipe, so we can't reply
  // there afterwards. We'll DM the summary instead.
  const responseChannelId = message.channelId;

  // Proceed with the wipe.
  console.log('[reset] Confirmation received. Starting wipe...');
  try {
    await message.channel?.send({ content: '✅ Terminal confirmation received. Starting wipe...' });
  } catch {
    // Channel might already be gone; ignore.
  }

  let result;
  try {
    result = await wipeServer(client, serverId, serverName);
  } catch (wipeError: any) {
    // This should never happen (wipeServer has its own safety net), but
    // if it does, don't let it kill the command — still deliver a summary.
    result = {
      deletedChannels: 0,
      deletedRoles: 0,
      deletedCategories: 0,
      errors: [`Wipe failed unexpectedly: ${wipeError?.message || wipeError}`],
    };
    console.error('[reset] wipeServer threw unexpectedly:', wipeError);
  }

  pendingReset = null;

  const summary =
    `# 🧨 Server Wipe Complete\n\n` +
    `**Server:** ${serverName} (\`${serverId}\`)\n\n` +
    `**Deleted:**\n` +
    `• Channels: ${result.deletedChannels}/${channelCount}\n` +
    `• Roles: ${result.deletedRoles}/${roleCount}\n` +
    `• Categories: ${result.deletedCategories}/${categoryCount}\n` +
    `• Bot data files: cleared\n` +
    `• YAOSB-Bot role: ${result.botRoleId ? `created/refreshed (assigned: ${result.botRoleAssigned ? 'yes' : 'no'})` : 'failed'}\n` +
    `• General channel: ${result.generalChannelCreated ? 'created' : 'failed'}\n\n` +
    (result.errors.length > 0
      ? `**Errors (${result.errors.length}):**\n${result.errors.slice(0, 10).map((e: string) => `• ${e}`).join('\n')}${result.errors.length > 10 ? `\n• ...and ${result.errors.length - 10} more` : ''}\n`
      : '');

  // The original response channel was almost certainly deleted in the wipe.
  // Try to DM the requester the summary; if that fails, just log to console.
  // Every API call here is individually wrapped — no .catch() chaining.
  let delivered = false;
  try {
    if (requesterId) {
      // Try to find the user object.
      let dmChannel: any = null;
      try {
        dmChannel = client.users?.cache?.get?.(requesterId) || null;
        if (!dmChannel && typeof client.users?.fetch === 'function') {
          dmChannel = await client.users.fetch(requesterId);
        }
      } catch {
        dmChannel = null;
      }

      // If the user object has a DM channel, send directly.
      if (dmChannel) {
        try {
          if (typeof dmChannel.send === 'function') {
            await dmChannel.send({ content: summary });
            delivered = true;
          } else if (typeof dmChannel.createDM === 'function') {
            const dm = await dmChannel.createDM();
            if (dm && typeof dm.send === 'function') {
              await dm.send({ content: summary });
              delivered = true;
            }
          }
        } catch (sendErr: any) {
          console.warn(`[reset] DM send to user failed: ${sendErr?.message || sendErr}`);
        }
      }

      // If that didn't work, try opening a DM via the API.
      if (!delivered && client?.api && typeof client.api.post === 'function') {
        try {
          const dm = await client.api.post('/users/@me/dms', { recipient: requesterId });
          if (dm?.id) {
            let dmCh: any = null;
            try {
              dmCh = client.channels?.cache?.get?.(dm.id) || await client.channels?.fetch?.(dm.id);
            } catch {
              dmCh = null;
            }
            if (dmCh && typeof dmCh.send === 'function') {
              await dmCh.send({ content: summary });
              delivered = true;
            }
          }
        } catch (apiDmErr: any) {
          console.warn(`[reset] DM via API failed: ${apiDmErr?.message || apiDmErr}`);
        }
      }
    }
  } catch (dmError: any) {
    console.warn(`[reset] Could not DM summary to requester: ${dmError?.message || dmError}`);
  }

  // Last resort: try the original channel (in case it wasn't in the wiped server).
  if (!delivered) {
    try {
      const ch = responseChannelId ? client.channels?.cache?.get?.(responseChannelId) : null;
      if (ch && typeof ch.send === 'function') {
        await ch.send({ content: summary });
        delivered = true;
      }
    } catch {
      // give up — the wipe succeeded, that's what matters
    }
  }

  console.log('[reset] Wipe complete:', result);
  console.log(`[reset] Summary ${delivered ? 'DMed to' : 'could not be delivered to'} requester ${requesterId}.`);
  console.log('[reset] Full summary:\n' + summary);
}

function printResetBanner(info: NonNullable<typeof pendingReset>) {
  const line = '═'.repeat(72);
  console.log('');
  console.log(`\x1b[31m${line}\x1b[0m`);
  console.log('\x1b[31m⚠️  SERVER RESET REQUESTED  ⚠️\x1b[0m');
  console.log(`\x1b[31m${line}\x1b[0m`);
  console.log(`  Server:      ${info.serverName}`);
  console.log(`  Server ID:   ${info.serverId}`);
  console.log(`  Requested by: ${info.requestedBy}`);
  console.log(`  Will delete:`);
  console.log(`    • ${info.channelCount} channel(s)`);
  console.log(`    • ${info.roleCount} role(s) (default @everyone preserved)`);
  console.log(`    • ${info.categoryCount} categor(ies)`);
  console.log(`    • All local bot data files`);
  console.log(`\x1b[31m${line}\x1b[0m`);
  console.log(`  Type \x1b[1myes\x1b[0m and press Enter to confirm.`);
  console.log(`  Type anything else (or wait ${RESET_CONFIRM_TIMEOUT_MS / 1000}s) to cancel.`);
  console.log(`\x1b[31m${line}\x1b[0m`);
  console.log('');
}

function waitForTerminalConfirmation(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    const timer = setTimeout(() => {
      rl.close();
      resolve(false);
    }, RESET_CONFIRM_TIMEOUT_MS);

    rl.question('Confirm reset? > ', (answer) => {
      clearTimeout(timer);
      rl.close();
      const trimmed = String(answer || '').trim().toLowerCase();
      resolve(trimmed === 'yes' || trimmed === 'confirm' || trimmed === 'y');
    });
  });
}

/**
 * Safe API call wrapper — NEVER throws. Returns {ok, error}.
 * This replaces the broken `.catch(() => { throw ... })` pattern that was
 * letting 403 errors escape try/catch blocks.
 */
async function safeApiCall(fn: () => Promise<any>): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Try to clear a channel's permission overrides so the bot can delete it.
 * This is needed when a channel has deny overrides on ManageChannel that
 * block deletion even though the bot has ManageChannel at the server level.
 *
 * Steps:
 * 1. Fetch the raw channel data to get role_permissions
 * 2. Clear the default permission override (PUT /channels/{id}/permissions/default)
 * 3. Clear each role-specific override (PUT /channels/{id}/permissions/{roleId})
 * 4. Return true if any overrides were cleared
 */
async function clearChannelPermissions(client: any, channelId: string): Promise<{ cleared: boolean; detail: string }> {
  if (!client?.api) return { cleared: false, detail: 'no API client' };

  let rolePermissions: Record<string, any> = {};
  let clearedAny = false;
  const details: string[] = [];

  // 1. Fetch raw channel data to discover role overrides.
  const fetchResult = await safeApiCall(() => client.api.get(`/channels/${channelId}`));
  if (fetchResult.ok) {
    // The get response might be wrapped; try to extract role_permissions.
    try {
      const raw = await client.api.get(`/channels/${channelId}`);
      if (raw?.role_permissions) {
        rolePermissions = raw.role_permissions;
      }
    } catch {
      // ignore — we'll still try to clear the default
    }
  }

  // 2. Clear the default permission override (allow: 0, deny: 0 = inherit server defaults).
  const defaultResult = await safeApiCall(() =>
    client.api.put(`/channels/${channelId}/permissions/default`, {
      body: { permissions: { allow: 0, deny: 0 } },
    })
  );
  if (defaultResult.ok) {
    clearedAny = true;
    details.push('cleared default');
  } else {
    // Try unwrapped body (some SDK versions don't wrap).
    const defaultResult2 = await safeApiCall(() =>
      client.api.put(`/channels/${channelId}/permissions/default`, {
        permissions: { allow: 0, deny: 0 },
      })
    );
    if (defaultResult2.ok) {
      clearedAny = true;
      details.push('cleared default (unwrapped)');
    } else {
      details.push(`default: ${defaultResult.error}`);
    }
  }

  // 3. Clear each role-specific override.
  for (const roleId of Object.keys(rolePermissions)) {
    const roleResult = await safeApiCall(() =>
      client.api.put(`/channels/${channelId}/permissions/${roleId}`, {
        body: { permissions: { allow: 0, deny: 0 } },
      })
    );
    if (roleResult.ok) {
      clearedAny = true;
      details.push(`cleared role ${roleId.slice(0, 6)}`);
    } else {
      // Try unwrapped.
      const roleResult2 = await safeApiCall(() =>
        client.api.put(`/channels/${channelId}/permissions/${roleId}`, {
          permissions: { allow: 0, deny: 0 },
        })
      );
      if (roleResult2.ok) {
        clearedAny = true;
        details.push(`cleared role ${roleId.slice(0, 6)} (unwrapped)`);
      }
    }
  }

  return { cleared: clearedAny, detail: details.join(', ') || 'no overrides found' };
}

/**
 * Pre-flight check: fetch the bot's member object in the target server and
 * report its permissions and roles. Stoat doesn't auto-create a bot role,
 * so the bot's permissions come from the server's default_permissions plus
 * any roles explicitly assigned to the bot member.
 */
async function checkBotPermissions(client: any, serverId: string): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];

  try {
    const botId = client.user?.id;
    if (!botId) {
      warnings.push('Could not determine bot user ID for permission check.');
      return { warnings };
    }

    let server: any = null;
    try {
      server = await client.servers.fetch(serverId);
    } catch {
      server = client.servers.cache.get(serverId);
    }
    if (!server) {
      warnings.push('Could not fetch server for permission check.');
      return { warnings };
    }

    let botMember: any = null;
    try {
      botMember = server.members?.cache?.get?.(botId) || await server.members?.fetch?.(botId);
    } catch {
      botMember = null;
    }
    if (!botMember) {
      warnings.push('Could not fetch bot member object — permission check skipped.');
      return { warnings };
    }

    // Check critical permissions.
    const requiredPerms = ['ManageServer', 'ManageChannels', 'ManageRoles', 'ManagePermissions'];
    for (const perm of requiredPerms) {
      try {
        if (typeof botMember.hasPermission === 'function') {
          const has = botMember.hasPermission(perm);
          if (!has) {
            warnings.push(`Bot is missing ${perm} permission. Some deletions will fail.`);
          }
        }
      } catch {
        // Some stoatbot.js versions use different spellings; try SCREAMING_SNAKE
        const snake = perm.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toUpperCase();
        try {
          if (typeof botMember.hasPermission === 'function' && !botMember.hasPermission(snake)) {
            warnings.push(`Bot is missing ${snake} permission. Some deletions will fail.`);
          }
        } catch {
          // give up on this perm
        }
      }
    }

    // Report the bot's roles and their ranks for hierarchy diagnosis.
    const botRoles: any[] = botMember.roles || [];
    if (botRoles.length === 0) {
      warnings.push('Bot has no roles assigned — it only has the server default permissions. Create a role with ManageRoles + ManageChannels and assign it to the bot for full reset capability.');
    } else {
      const roleInfos = botRoles.map((r: any) => `${r.name || 'unnamed'} (rank: ${r.rank ?? '?'})`).join(', ');
      console.log(`[reset] Bot has ${botRoles.length} role(s): ${roleInfos}`);
      const maxRank = Math.max(...botRoles.map((r: any) => typeof r.rank === 'number' ? r.rank : -1));
      if (maxRank < 0) {
        warnings.push('Bot roles have no rank set — role hierarchy may block deletion of ranked roles.');
      }
    }
  } catch (error: any) {
    warnings.push(`Permission pre-flight check failed: ${error?.message || error}`);
  }

  return { warnings };
}

// ============================================================
// YAOSB-Bot role + general channel setup
// ============================================================

const YAOSB_BOT_ROLE_NAME = 'YAOSB-Bot';
const GENERAL_CHANNEL_NAME = 'general';

// Server-level allow bitmask for the YAOSB-Bot role — gives the bot everything
// it needs to delete channels/roles even when @everyone denies it.
const YAOSB_BOT_ROLE_ALLOW = Number(
  Permission.ViewChannel |
  Permission.ReadMessageHistory |
  Permission.SendMessage |
  Permission.ManageMessages |
  Permission.SendEmbeds |
  Permission.UploadFiles |
  Permission.Masquerade |
  Permission.React |
  Permission.ManageChannel |
  Permission.ManagePermissions |
  Permission.ManageRole |
  Permission.ManageServer
);

/**
 * Find or create a "YAOSB-Bot" role on the target server, set its server-level
 * permissions to allow the bot everything it needs (including ManageChannel +
 * ManagePermissions + ManageRole + ManageServer), set its rank high, and assign
 * it to the bot. This lets the bot delete channels/roles even when @everyone
 * has restrictive deny overrides.
 *
 * Idempotent: re-running reset refreshes perms and re-assigns.
 */
async function ensureBotRole(client: any, targetServer: any): Promise<{ roleId: string | null; assigned: boolean; error?: string }> {
  try {
    console.log('[reset] Ensuring YAOSB-Bot role exists and is assigned to the bot.');

    // Check if YAOSB-Bot role already exists.
    const existingRoleId = findRoleByName(targetServer, YAOSB_BOT_ROLE_NAME);

    let roleId: string | null = null;

    if (existingRoleId) {
      // Role exists — try to update its permissions and rank.
      // This requires ManagePermissions; if it fails, the role keeps its
      // existing permissions (which may be sufficient if set at creation).
      roleId = existingRoleId;
      console.log(`[reset]   ✓ Found existing YAOSB-Bot role: ${roleId}`);

      // Try to refresh permissions (best-effort).
      const permsResult = await safeApiCall(() =>
        client.api?.put(`/servers/${targetServer.id}/permissions/${roleId}`, {
          body: { permissions: { allow: YAOSB_BOT_ROLE_ALLOW, deny: 0 } },
        })
      );
      if (permsResult.ok) {
        console.log('[reset]   ✓ YAOSB-Bot role permissions refreshed.');
      } else {
        // Try unwrapped body.
        const permsResult2 = await safeApiCall(() =>
          client.api?.put(`/servers/${targetServer.id}/permissions/${roleId}`, {
            permissions: { allow: YAOSB_BOT_ROLE_ALLOW, deny: 0 },
          })
        );
        if (permsResult2.ok) {
          console.log('[reset]   ✓ YAOSB-Bot role permissions refreshed (unwrapped).');
        } else {
          console.warn(`[reset]   ⚠️ Could not refresh YAOSB-Bot role permissions: ${permsResult.error}. If the role was created with correct permissions, this is OK.`);
        }
      }

      // Try to refresh rank.
      const existingRoleIds = (Array.from(targetServer?.roles?.cache?.values?.() || []) as any[]).map((r: any) => r?.id).filter(Boolean);
      const rank = existingRoleIds.length > 0 ? existingRoleIds.length + 1 : 9999;
      const rankResult = await safeApiCall(() =>
        client.api?.patch(`/servers/${targetServer.id}/roles/${roleId}`, { body: { rank } })
      );
      if (!rankResult.ok) {
        await safeApiCall(() =>
          client.api?.patch(`/servers/${targetServer.id}/roles/${roleId}`, { rank })
        );
      }
    } else {
      // Role doesn't exist — create it WITH permissions set at creation time.
      // Stoat's POST /servers/{id}/roles accepts { name, rank, permissions } in the body
      // and only requires ManageRoles (NOT ManagePermissions).
      // The permissions format is { a: string, d: string } (allow/deny as strings).
      console.log('[reset]   Creating YAOSB-Bot role with permissions set at creation time...');
      const existingRoleIds = (Array.from(targetServer?.roles?.cache?.values?.() || []) as any[]).map((r: any) => r?.id).filter(Boolean);
      const rank = existingRoleIds.length > 0 ? existingRoleIds.length + 1 : 9999;
      const createBody = {
        name: YAOSB_BOT_ROLE_NAME,
        rank,
        // Stoat's editablePermissions format: { a: allow_string, d: deny_string }
        permissions: { a: String(YAOSB_BOT_ROLE_ALLOW), d: '0' },
      };

      let created: any = null;
      // Try wrapped body first.
      const createResult1 = await safeApiCall(() =>
        client.api?.post(`/servers/${targetServer.id}/roles`, { body: createBody })
      );
      if (createResult1.ok) {
        created = await client.api?.post(`/servers/${targetServer.id}/roles`, { body: createBody });
      } else {
        // Try unwrapped body.
        const createResult2 = await safeApiCall(() =>
          client.api?.post(`/servers/${targetServer.id}/roles`, createBody)
        );
        if (createResult2.ok) {
          created = await client.api?.post(`/servers/${targetServer.id}/roles`, createBody);
        } else {
          // Try SDK method as last resort (only accepts name, no permissions).
          if (typeof targetServer?.createRole === 'function') {
            created = await targetServer.createRole(YAOSB_BOT_ROLE_NAME);
          } else if (typeof targetServer?.roles?.create === 'function') {
            created = await targetServer.roles.create(YAOSB_BOT_ROLE_NAME);
          }
        }
      }

      roleId = created?.id || created?._id || created?.role?.id || null;
      if (!roleId) {
        return { roleId: null, assigned: false, error: 'could not create YAOSB-Bot role' };
      }
      console.log(`[reset]   ✓ Created YAOSB-Bot role: ${roleId} (with permissions at creation time)`);
    }

    // Assign to the bot.
    const botId = client?.user?.id;
    if (!botId) {
      return { roleId, assigned: false, error: 'client.user.id not available' };
    }

    let botMember: any = null;
    try {
      botMember = targetServer?.members?.cache?.get?.(botId) || await targetServer?.members?.fetch?.(botId);
    } catch {
      botMember = null;
    }
    if (!botMember) {
      return { roleId, assigned: false, error: 'could not fetch bot member' };
    }

    // Check if already has the role.
    const currentRoles = getMemberRoleIds(botMember);
    if (currentRoles.includes(roleId)) {
      console.log('[reset]   ✓ Bot already has the YAOSB-Bot role.');
      return { roleId, assigned: true };
    }

    // Assign via member.addRole.
    if (typeof botMember.addRole === 'function') {
      const assignResult = await safeApiCall(() => botMember.addRole(roleId));
      if (assignResult.ok) {
        console.log('[reset]   ✓ YAOSB-Bot role assigned to the bot.');
        return { roleId, assigned: true };
      }
    }

    // Fallback: direct API.
    const apiResult = await safeApiCall(() =>
      client.api?.put(`/servers/${targetServer.id}/members/${botId}/roles/${roleId}`)
    );
    if (apiResult.ok) {
      console.log('[reset]   ✓ YAOSB-Bot role assigned to the bot via API.');
      return { roleId, assigned: true };
    }

    return { roleId, assigned: false, error: apiResult.error || 'addRole failed' };
  } catch (error: any) {
    return { roleId: null, assigned: false, error: error?.message || String(error) };
  }
}

/**
 * Find an existing role by name. Returns the role ID or null.
 */
function findRoleByName(targetServer: any, name: string): string | null {
  const target = String(name || '').toLowerCase();
  if (!target) return null;

  for (const role of Array.from(targetServer?.roles?.values?.() || []) as any[]) {
    if (typeof role === 'object' && String(role.name || '').toLowerCase() === target && role.id) {
      return role.id;
    }
  }
  for (const role of Array.from(targetServer?.roles?.cache?.values?.() || []) as any[]) {
    if (typeof role === 'object' && String(role.name || '').toLowerCase() === target && role.id) {
      return role.id;
    }
  }
  return null;
}

/**
 * Find an existing role by name, or create it.
 */
async function findOrCreateRoleByName(targetServer: any, name: string): Promise<string | null> {
  const target = String(name || '').toLowerCase();

  // Search role cache.
  for (const role of Array.from(targetServer?.roles?.values?.() || []) as any[]) {
    if (typeof role === 'object' && String(role.name || '').toLowerCase() === target && role.id) {
      return role.id;
    }
  }
  for (const role of Array.from(targetServer?.roles?.cache?.values?.() || []) as any[]) {
    if (typeof role === 'object' && String(role.name || '').toLowerCase() === target && role.id) {
      return role.id;
    }
  }

  // Create it.
  try {
    let created: any;
    if (typeof targetServer?.createRole === 'function') {
      created = await targetServer.createRole(name);
    } else if (typeof targetServer?.roles?.create === 'function') {
      created = await targetServer.roles.create(name);
    } else {
      const api = targetServer?.client?.api || targetServer?.api;
      created = await api?.post(`/servers/${targetServer.id}/roles`, { body: { name } });
    }
    const newId = created?.id || created?.role?.id || created?._id;
    return newId || null;
  } catch (error: any) {
    console.warn(`[reset] Failed to create "${name}" role: ${error?.message || error}`);
    return null;
  }
}

function getMemberRoleIds(member: any): string[] {
  const roles = member?.roles;
  if (!roles) return [];
  // stoatbot.js returns Role[] (objects with .id), not string IDs.
  if (Array.isArray(roles)) return roles.map((r: any) => typeof r === 'string' ? r : (r?.id || r?._id)).filter(Boolean);
  if (typeof roles.toArray === 'function') return roles.toArray().map((r: any) => typeof r === 'string' ? r : (r?.id || r?._id)).filter(Boolean);
  if (roles instanceof Set) return Array.from(roles).map((r: any) => typeof r === 'string' ? r : (r?.id || r?._id)).filter(Boolean);
  if (typeof roles === 'object') return Object.keys(roles);
  return [];
}

/**
 * Create a "general" channel — Stoat enforces a 1-channel minimum per server,
 * so we can't delete the last channel. Pre-creating general ensures there's
 * always at least one channel during the wipe.
 */
async function createGeneralChannel(client: any, targetServer: any): Promise<{ channelId: string | null; error?: string }> {
  try {
    console.log('[reset] Creating "general" channel (Stoat 1-channel minimum safeguard).');
    let created: any;
    if (typeof targetServer?.channels?.create === 'function') {
      created = await targetServer.channels.create({ name: GENERAL_CHANNEL_NAME, type: 'Text' });
    } else if (typeof targetServer?.createChannel === 'function') {
      created = await targetServer.createChannel({ name: GENERAL_CHANNEL_NAME, type: 'Text' });
    } else {
      created = await client.api?.post(`/servers/${targetServer.id}/channels`, { body: { name: GENERAL_CHANNEL_NAME, type: 'Text' } });
    }
    const newId = created?.id || created?._id || created?.channel?.id;
    if (newId) {
      console.log(`[reset]   ✓ Created "general" channel: ${newId}`);
    }
    return { channelId: newId || null };
  } catch (error: any) {
    return { channelId: null, error: error?.message || String(error) };
  }
}

/**
 * Set a per-channel allow override for the YAOSB-Bot role on a specific channel.
 * This grants the YAOSB-Bot role (and thus the bot) full permissions on THIS
 * specific channel, overriding any @everyone deny override that blocks deletion.
 *
 * Endpoint: PUT /channels/{channelId}/permissions/{roleId}
 * Body: { permissions: { allow: FULL, deny: 0 } }
 * Requires: ManagePermissions (which the YAOSB-Bot role has at server level).
 */
async function grantBotChannelOverride(client: any, channelId: string, roleId: string): Promise<{ ok: boolean; error?: string }> {
  if (!client?.api || typeof client.api.put !== 'function') {
    return { ok: false, error: 'no API client' };
  }

  const permissions = { allow: YAOSB_BOT_ROLE_ALLOW, deny: 0 };

  // Try wrapped body format.
  let result = await safeApiCall(() =>
    client.api.put(`/channels/${channelId}/permissions/${roleId}`, {
      body: { permissions },
    })
  );
  if (result.ok) return { ok: true };

  // Try unwrapped body format.
  result = await safeApiCall(() =>
    client.api.put(`/channels/${channelId}/permissions/${roleId}`, {
      permissions,
    })
  );
  if (result.ok) return { ok: true };

  // Try flat format (permissions as top-level).
  result = await safeApiCall(() =>
    client.api.put(`/channels/${channelId}/permissions/${roleId}`, permissions)
  );
  if (result.ok) return { ok: true };

  return { ok: false, error: result.error || 'unknown error' };
}

async function wipeServer(client: any, serverId: string, serverName: string) {
  const result = {
    deletedChannels: 0,
    deletedRoles: 0,
    deletedCategories: 0,
    botRoleId: null as string | null,
    botRoleAssigned: false,
    generalChannelCreated: false,
    errors: [] as string[],
  };

  // TOP-LEVEL SAFETY NET: nothing inside this function should ever throw.
  // Every API call is wrapped in its own try/catch via safeApiCall or direct
  // try/catch. If something unexpected happens, catch it here and return
  // what we have so far.
  try {
    let server = null;
    try {
      server = await client.servers.fetch(serverId);
    } catch {
      server = client.servers.cache.get(serverId);
    }
    if (!server) {
      result.errors.push('Could not re-fetch server after confirmation.');
      return result;
    }

    // 0a. Ensure the YAOSB-Bot role exists and is assigned to the bot.
    //     This gives the bot ManageChannel + ManagePermissions at the server
    //     level, bypassing restrictive @everyone deny overrides on channels.
    const roleResult = await ensureBotRole(client, server);
    result.botRoleId = roleResult.roleId;
    result.botRoleAssigned = roleResult.assigned;
    if (!roleResult.roleId || !roleResult.assigned) {
      result.errors.push(`YAOSB-Bot role setup: ${roleResult.error || 'unknown error'}. Channel/role deletions may fail on restrictive @everyone overrides.`);
      console.warn(`[reset] ⚠️ YAOSB-Bot role setup failed: ${roleResult.error}`);
    }

    // 0b. Create a "general" channel before deleting — Stoat enforces a
    //     1-channel minimum per server. Without this, deleting the last
    //     channel fails.
    const generalResult = await createGeneralChannel(client, server);
    if (generalResult.channelId) {
      result.generalChannelCreated = true;
    } else {
      result.errors.push(`Could not create "general" channel: ${generalResult.error}`);
      console.warn(`[reset] ⚠️ Could not create "general" channel: ${generalResult.error}`);
    }

    // 1a. Grant the YAOSB-Bot role a per-channel allow override on EVERY channel.
    //     This overrides any @everyone deny that would block deletion.
    const channels: any[] = Array.from(server.channels?.cache?.values?.() || []);
    if (channels.length > 0 && result.botRoleId) {
      console.log(`[reset] Granting YAOSB-Bot channel overrides on ${channels.length} channel(s)...`);
      let granted = 0;
      for (const channel of channels) {
        const channelId = channel?.id;
        if (!channelId || channelId === generalResult.channelId) continue;
        const grantResult = await grantBotChannelOverride(client, channelId, result.botRoleId);
        if (grantResult.ok) {
          granted += 1;
        } else {
          console.warn(`[reset]   ⚠️ Could not grant override on "${channel?.name}" (${channelId}): ${grantResult.error}`);
        }
        await sleep(50);
      }
      console.log(`[reset]   ✓ Granted overrides on ${granted}/${channels.length} channel(s).`);
    }

    // 1b. Delete all channels — EXCEPT the "general" channel we just created
    //     (it's the 1-channel-minimum safeguard; deleting it defeats the purpose).
    const channelsToDelete = channels.filter((ch: any) => ch?.id !== generalResult.channelId);
    console.log(`[reset] Deleting ${channelsToDelete.length} channel(s) (skipping "general")...`);
    for (const channel of channelsToDelete) {
      const channelId = channel?.id;
      const channelName = channel?.name || channelId;
      let deleted = false;

      // Try the SDK method first.
      const sdkResult = await safeApiCall(() => channel.delete());
      if (sdkResult.ok) {
        deleted = true;
      } else {
        // Try direct API fallback.
        if (channelId && client?.api && typeof client.api.delete === 'function') {
          const apiResult = await safeApiCall(() => client.api.delete(`/channels/${channelId}`));
          if (apiResult.ok) {
            deleted = true;
            console.log(`[reset]   ✓ Deleted channel "${channelName}" (${channelId}) via direct API fallback`);
          } else {
            // Both SDK and direct API failed. If it's a 403, the channel likely
            // has permission overrides denying the bot ManageChannel. Try to
            // clear those overrides, then retry the delete.
            const bothErrors = `${sdkResult.error} | API: ${apiResult.error}`;
            if (/403|forbidden/i.test(bothErrors)) {
              console.log(`[reset]   ⏳ Channel "${channelName}" returned 403; granting YAOSB-Bot override + retrying...`);
              // Try granting a per-channel override for the YAOSB-Bot role.
              if (result.botRoleId) {
                const grantResult = await grantBotChannelOverride(client, channelId, result.botRoleId);
                if (grantResult.ok) {
                  console.log(`[reset]   ✓ Granted YAOSB-Bot override on "${channelName}"; retrying delete...`);
                  const retryResult = await safeApiCall(() => channel.delete());
                  if (retryResult.ok) {
                    deleted = true;
                    console.log(`[reset]   ✓ Deleted channel "${channelName}" (${channelId}) after granting override`);
                  } else {
                    const retryApiResult = await safeApiCall(() => client.api.delete(`/channels/${channelId}`));
                    if (retryApiResult.ok) {
                      deleted = true;
                      console.log(`[reset]   ✓ Deleted channel "${channelName}" (${channelId}) via API after granting override`);
                    }
                  }
                }
              }
              // If still not deleted, try clearing all overrides as fallback.
              if (!deleted) {
                console.log(`[reset]   ⏳ Trying to clear all permission overrides on "${channelName}"...`);
                const clearResult = await clearChannelPermissions(client, channelId);
                if (clearResult.cleared) {
                  const retryResult = await safeApiCall(() => channel.delete());
                  if (retryResult.ok) {
                    deleted = true;
                    console.log(`[reset]   ✓ Deleted channel "${channelName}" (${channelId}) after clearing overrides`);
                  } else {
                    const retryApiResult = await safeApiCall(() => client.api.delete(`/channels/${channelId}`));
                    if (retryApiResult.ok) {
                      deleted = true;
                      console.log(`[reset]   ✓ Deleted channel "${channelName}" (${channelId}) via API after clearing overrides`);
                    }
                  }
                }
              }
              if (!deleted) {
                result.errors.push(`Channel "${channelName}" (${channelId}): 403 Forbidden — could not delete even after granting YAOSB-Bot override. The bot may lack ManagePermissions. Ensure the YAOSB-Bot role (or CrabTest) has ManagePermissions + ManageChannels at the server level.`);
                console.warn(`[reset]   ✗ Failed to delete channel "${channelName}" after all fallbacks`);
              }
            } else {
              result.errors.push(`Channel "${channelName}" (${channelId}): ${sdkResult.error} | API: ${apiResult.error}`);
              console.warn(`[reset]   ✗ Failed to delete channel "${channelName}" (SDK: ${sdkResult.error}, API: ${apiResult.error})`);
            }
          }
        } else {
          result.errors.push(`Channel "${channelName}" (${channelId}): ${sdkResult.error}`);
          console.warn(`[reset]   ✗ Failed to delete channel "${channelName}": ${sdkResult.error}`);
        }
      }

      if (deleted) {
        result.deletedChannels += 1;
        if (!channelName.includes('via direct API')) {
          console.log(`[reset]   ✓ Deleted channel "${channelName}" (${channelId})`);
        }
      }
      await sleep(DELETE_PACE_MS);
    }

    // 2. Delete all roles except:
    //    - the default @everyone role (Stoat doesn't allow deleting it)
    //    - the YAOSB-Bot role we just created (needed for bot permissions during wipe)
    //    - any role currently assigned to the bot (deleting these would strip
    //      the bot's own permissions mid-wipe, e.g. a user-created "CrabTest"
    //      role that gives the bot ManageServer)
    const botIdForRoles = client?.user?.id;
    let botRoleIds: Set<string> = new Set();
    if (botIdForRoles) {
      try {
        const botMemberForRoles = server?.members?.cache?.get?.(botIdForRoles) || await server?.members?.fetch?.(botIdForRoles);
        if (botMemberForRoles) {
          botRoleIds = new Set(getMemberRoleIds(botMemberForRoles));
        }
      } catch {
        // ignore — proceed without bot role info
      }
    }

    const roles: any[] = (Array.from(server.roles?.cache?.values?.() || []) as any[]).filter((r: any) => {
      if (isDefaultRole(r)) return false;
      if (r?.id && botRoleIds.has(r.id)) return false; // don't delete bot's own roles
      const name = String(r?.name || '').toLowerCase();
      // Legacy crab* names are kept so servers set up before the rename keep
      // their helper roles.
      const PROTECTED_ROLE_NAMES = ['yaosb-bot', 'yetanotheroverengineeredstoatbot', 'crabbot', 'crabgod'];
      if (PROTECTED_ROLE_NAMES.includes(name)) return false; // don't delete our helper roles
      return true;
    });
    if (botRoleIds.size > 0) {
      console.log(`[reset] Skipping ${botRoleIds.size} role(s) assigned to the bot (needed for permissions).`);
    }
    console.log(`[reset] Deleting ${roles.length} role(s)...`);
    for (const role of roles) {
      const roleId = role?.id;
      const roleName = role?.name || roleId;
      let deleted = false;

      const sdkResult = await safeApiCall(() => role.delete());
      if (sdkResult.ok) {
        deleted = true;
      } else {
        // Direct API fallback: DELETE /servers/{target}/roles/{role_id}
        if (roleId && client?.api && typeof client.api.delete === 'function') {
          const apiResult = await safeApiCall(() => client.api.delete(`/servers/${serverId}/roles/${roleId}`));
          if (apiResult.ok) {
            deleted = true;
            console.log(`[reset]   ✓ Deleted role "${roleName}" (${roleId}) via direct API fallback`);
          } else {
            const bothErrors = `${sdkResult.error} | API: ${apiResult.error}`;
            if (/403|forbidden/i.test(bothErrors)) {
              result.errors.push(`Role "${roleName}" (${roleId}): 403 Forbidden — bot lacks ManageRoles permission, or its highest role rank is not above "${roleName}"'s rank. In Stoat: create/edit a role with ManageRoles permission and a higher rank than "${roleName}", then assign that role to the bot.`);
              console.warn(`[reset]   ✗ Failed to delete role "${roleName}": 403 — bot lacks ManageRoles or rank is too low`);
            } else {
              result.errors.push(`Role "${roleName}" (${roleId}): ${sdkResult.error} | API: ${apiResult.error}`);
              console.warn(`[reset]   ✗ Failed to delete role "${roleName}" (SDK: ${sdkResult.error}, API: ${apiResult.error})`);
            }
          }
        } else {
          result.errors.push(`Role "${roleName}" (${roleId}): ${sdkResult.error}`);
          console.warn(`[reset]   ✗ Failed to delete role "${roleName}": ${sdkResult.error}`);
        }
      }

      if (deleted) {
        result.deletedRoles += 1;
        if (!roleName.includes('via direct API')) {
          console.log(`[reset]   ✓ Deleted role "${roleName}" (${roleId})`);
        }
      }
      await sleep(DELETE_PACE_MS);
    }

    // 3. Categories — clear via direct PATCH /servers/{target}.
    // The SDK's api.patch expects { body: { ... } } wrapping.
    // Stoat may reject categories: [] (empty); use a minimal default category.
    try {
      const before = categoryCountFromServer(server);
      if (client?.api && typeof client.api.patch === 'function') {
        // Try with { body: ... } wrapping first (correct SDK format).
        let catResult = await safeApiCall(() =>
          client.api.patch(`/servers/${serverId}`, {
            body: { categories: [{ id: 'default', title: 'Default', channels: [] }] },
          })
        );

        // If that fails, try unwrapped body.
        if (!catResult.ok) {
          catResult = await safeApiCall(() =>
            client.api.patch(`/servers/${serverId}`, {
              categories: [{ id: 'default', title: 'Default', channels: [] }],
            })
          );
        }

        // If that also fails, try empty array.
        if (!catResult.ok) {
          catResult = await safeApiCall(() =>
            client.api.patch(`/servers/${serverId}`, {
              body: { categories: [] },
            })
          );
        }

        if (catResult.ok) {
          result.deletedCategories = before;
          console.log(`[reset]   ✓ Cleared ${before} server categor(ies) via direct API`);
        } else {
          // Non-fatal — channels are already gone, empty categories are harmless.
          result.errors.push(`Categories: ${catResult.error} (non-fatal — channels already deleted)`);
          console.warn(`[reset]   ✗ Failed to clear categories (non-fatal): ${catResult.error}`);
        }
      }
    } catch (catError: any) {
      result.errors.push(`Categories: ${catError?.message || catError} (non-fatal)`);
      console.warn(`[reset]   ✗ Failed to clear categories (non-fatal): ${catError?.message || catError}`);
    }

    // 4. Clear all local bot data files.
    console.log('[reset] Clearing bot data files...');
    try {
      clearBotData();
      console.log('[reset]   ✓ Bot data cleared');
    } catch (error: any) {
      const detail = error?.message || String(error);
      result.errors.push(`Bot data: ${detail}`);
      console.warn(`[reset]   ✗ Failed to clear bot data: ${detail}`);
    }
  } catch (topError: any) {
    // SAFETY NET: if anything unexpected escaped the inner try/catch blocks,
    // catch it here so the caller never sees a throw.
    const detail = topError?.message || String(topError);
    result.errors.push(`Unexpected error during wipe: ${detail}`);
    console.error('[reset] UNEXPECTED ERROR during wipe (caught by safety net):', detail);
  }

  return result;
}

function categoryCountFromServer(server: any): number {
  const categories = server?.categories;
  if (!categories) return 0;
  if (typeof categories.values === 'function') return Array.from(categories.values()).length;
  if (Array.isArray(categories)) return categories.length;
  return 0;
}

function isDefaultRole(role: any): boolean {
  if (!role) return true;
  // Stoat's default @everyone role has the same ID as the server.
  // Some stoatbot.js versions expose it as role.name === 'default' or
  // role.default === true.
  if (role.default === true) return true;
  if (String(role.name || '').toLowerCase() === 'default') return true;
  // The default role's rank is typically 0 or undefined.
  if (role.rank === 0 && !role.permissions) return true;
  return false;
}

function clearBotData() {
  // The shared store path, so an instance running with YAOSB_DATA_DIR clears
  // its own data instead of the repo default. Guarded against a misconfigured
  // root path before anything is deleted.
  const dataDir = DATA_DIR;
  assertSafeDataDir();

  mkdirSync(dataDir, { recursive: true });
  // Only the JSON stores at the top level. Subdirectories survive on purpose:
  // `backups/` is the recovery path for exactly this kind of wipe, and `bin/`
  // holds downloaded binaries that have nothing to do with server state.
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      rmSync(join(dataDir, entry.name), { force: true });
    }
  }

  // Write empty JSON objects for the files the bot expects to exist.
  const emptyFiles = [
    'tickets.json',
    'counter.json',
    'ticket-cooldowns.json',
    'reaction-roles.json',
    'join-roles.json',
    'stats-channels.json',
    'log-config.json',
    'custom-embeds.json',
    'welcome.json',
    'welcome-images.json',
  ];
  for (const fileName of emptyFiles) {
    const filePath = join(dataDir, fileName);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, '{}\n', 'utf-8');
    }
  }

  // The stores kept in SQLite (leveling, economy, activity, analytics, audit,
  // moderation, the sync ledger): emptied in place, since the open database
  // file cannot be deleted from under the running bot.
  wipeDatabase();

  // Modules that keep a store in memory would otherwise write the wiped data
  // straight back on their next save.
  reloadAllDataFiles();
}
