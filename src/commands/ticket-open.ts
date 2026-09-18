import { config } from '../config.js';
import { ticketDb, ticketCooldownDb } from '../database.js';
import { moveChannelToCategory, getReadableError } from '../category-utils.js';
import { TicketPermissions, isTicketStaff } from '../permissions.js';
import { logTicketAction } from '../log-system.js';
import { MessageEmbed } from 'stoatbot.js';
import { sleep } from '../async-utils.js';

export const DEFAULT_TICKET_REASON = 'No reason provided';
const TICKET_CREATE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Open a new ticket
 * Usage: !ticket open [reason]
 */
export async function ticketOpen(message, args, client) {
  const reason = args.join(' ').trim();
  await createTicketForUser({
    client,
    userId: message.authorId,
    username: message.author?.username,
    responseChannel: message.channel,
    reason,
  });
}

/**
 * Shared ticket creation flow for both command-based and reaction-based opening.
 */
export async function createTicketForUser({
  client,
  userId,
  username,
  responseChannel,
  reason,
}) {
  const normalizedReason = reason?.trim() || DEFAULT_TICKET_REASON;

  const remainingCooldownMs = ticketCooldownDb.getRemainingMs(userId, TICKET_CREATE_COOLDOWN_MS);
  if (remainingCooldownMs > 0) {
    await sendTicketOpenResponse({
      client,
      userId,
      responseChannel,
      content:
        `⏳ You can open a new ticket in ${formatDuration(remainingCooldownMs)}. ` +
        `Cooldown is 10 minutes between ticket creations.`,
    });
    return;
  }

  // Reserve the cooldown BEFORE doing any async work. This closes the race
  // where two parallel `!ticket open` calls both pass the check above and
  // both proceed to create channels. If creation fails below, we still
  // keep the cooldown set so the user can't spam retries — they can wait
  // 10 minutes or ask staff to intervene.
  ticketCooldownDb.setLastCreatedAt(userId);

  let createdTicketRoleId = null;
  let creatorIsStaff = false;
  let creatorHasTicketRole = false;
  let botHasSupportRole = false;
  let botHasTicketRole = false;
  let botMember: any = null;

  // Get the server
  let server = null;
  try {
    server = await client.servers.fetch(config.serverId);
  } catch {
    server = client.servers.cache.get(config.serverId);
  }
  if (!server) {
    await sendTicketOpenResponse({
      client,
      userId,
      responseChannel,
      content: '❌ Could not find the configured server. Please contact an administrator.',
    });
    return;
  }
  
  // Create the ticket in the database first to get the ID
  const ticketData = {
    creatorId: userId,
    creatorUsername: username || 'Unknown User',
    reason: normalizedReason,
    serverId: config.serverId,
  };
  
  const ticket = ticketDb.create(ticketData);
  const channelName = `ticket-${ticket.ticketId}`;
  
  try {
    // Create the channel in the server
    const channel = await server.channels.create({
      type: 'Text',
      name: channelName,
      description: `Support ticket opened by ${username || 'Unknown User'}`,
    });
    console.log(`[ticket:${ticket.ticketId}] channel created (${channel.id})`);

    // Update ticket with channel ID as soon as we have it.
    // Cooldown was already set above before any async work began.
    ticketDb.update(ticket.ticketId, { channelId: channel.id });
    console.log(`[ticket:${ticket.ticketId}] db updated`);

    // Respond early for better UX; heavy setup continues below.
    await sendTicketOpenResponse({
      client,
      userId,
      responseChannel,
      content: `✅ Your ticket has been created! Please head to <#${channel.id}> to continue.`,
    });
    console.log(`[ticket:${ticket.ticketId}] creation acknowledged to user`);

    // Send welcome message
    try {
      const ticketEmbed = new MessageEmbed()
        .setTitle(`🎫 Ticket #${ticket.ticketId}`)
        .setDescription(
          `**Opened by:** <@${userId}>\n` +
          `**Reason:** ${normalizedReason}\n\n` +
          `Welcome! A support staff member will be with you shortly.\n\n` +
          `**Commands:**\n` +
          `• \`${config.prefix}ticket close\` - Close this ticket\n` +
          `• \`${config.prefix}ticket transcript\` - Generate a transcript (only after closing)`
        )
        .setColor('#22c55e');

      await channel.send({
        content: `<@${userId}>`,
        embeds: [ticketEmbed],
      });
      console.log(`[ticket:${ticket.ticketId}] initial message sent`);
    } catch (welcomeError) {
      console.error('Failed to send initial ticket message:', welcomeError?.message || welcomeError);
    }

    // Start role setup after channel creation so perceived ticket-open latency is minimal.
    const roleSetupPromise = (async () => {
      try {
        const createdRole = await server.roles.create(`ticketrole-${ticket.ticketId}`);
        createdTicketRoleId = createdRole?.id || null;

        if (createdTicketRoleId) {
          ticketDb.update(ticket.ticketId, { ticketRoleId: createdTicketRoleId });

          const botId = client.user?.id;
          if (botId) {
            botMember = await server.members.fetch(botId).catch(() => null);
            if (botMember) {
              const botRoles = extractRoleIds(botMember.roles);
              botHasSupportRole = botRoles.includes(config.supportRoleId);
            }
          }

          const creatorMember = await server.members.fetch(userId).catch(() => null);
          creatorIsStaff = !!creatorMember && (await isTicketStaff(client, config.serverId, userId, creatorMember, config.supportRoleId));

          if (creatorMember && !creatorIsStaff) {
            const canAssignCreatorRole = canAssignRoleByHierarchy(server, botMember, creatorMember, createdTicketRoleId);

            if (canAssignCreatorRole === false) {
              console.warn(
                `[ticket:${ticket.ticketId}] cannot assign ticket role to creator (${userId}) due role hierarchy (NotElevated risk); skipping restrictive lock-down.`
              );
            } else {
              try {
                const currentRoles = extractRoleIds(creatorMember.roles);
                if (!currentRoles.includes(createdTicketRoleId)) {
                  await creatorMember.addRole(createdTicketRoleId);
                }

                creatorHasTicketRole = true;
              } catch (creatorRoleError) {
                console.warn(
                  `[ticket:${ticket.ticketId}] could not assign ticket role to creator (${userId}); skipping restrictive lock-down:`,
                  getReadableError(creatorRoleError)
                );
              }
            }
          } else if (creatorIsStaff) {
            creatorHasTicketRole = true;
          }

          // Ensure bot itself keeps access even when @everyone is denied.
          if (botMember) {
            const botRoles = extractRoleIds(botMember.roles);

            if (botRoles.includes(createdTicketRoleId)) {
              botHasTicketRole = true;
            } else {
              // Editing own roles frequently fails with NotElevated on Stoat.
              const canAssignBotSelfRole = canAssignRoleByHierarchy(server, botMember, botMember, createdTicketRoleId);

              if (canAssignBotSelfRole === false) {
                console.warn(
                  `[ticket:${ticket.ticketId}] skipped assigning ticket role to bot itself due role hierarchy (expected NotElevated on self-edit).`
                );
              } else {
                try {
                  await botMember.addRole(createdTicketRoleId);
                  botHasTicketRole = true;
                } catch (botRoleError) {
                  console.warn(
                    `[ticket:${ticket.ticketId}] could not assign ticket role to bot member; continuing with support-role access only:`,
                    getReadableError(botRoleError)
                  );
                }
              }
            }
          }
        }
      } catch (roleError) {
        console.error(`[ticket:${ticket.ticketId}] failed to create/assign ticket role:`, getReadableError(roleError));
      }
    })();

    // Ensure role setup has completed before evaluating channel lock-down logic.
    await roleSetupPromise;

    // Apply role-based access for this ticket channel
    // - default: deny basic channel access
    // - support role: allow full ticket access
    // - ticket role: allow full ticket access (for non-staff ticket participants)
    try {
      await channel.setRolePermissions(config.supportRoleId, {
        allow: fullAccessPermissions,
        deny: [],
      });

      const botCanStillAccess = botHasSupportRole || botHasTicketRole;
      const creatorCanStillAccess = creatorIsStaff || creatorHasTicketRole;

      if (createdTicketRoleId && botCanStillAccess && creatorCanStillAccess) {
        await channel.setDefaultPermissions({
          allow: [],
          deny: denyAllPermissions,
        });

        await channel.setRolePermissions(createdTicketRoleId, {
          allow: fullAccessPermissions,
          deny: [],
        });
      } else if (creatorIsStaff && botCanStillAccess) {
        await channel.setDefaultPermissions({
          allow: [],
          deny: denyAllPermissions,
        });
      } else if (creatorIsStaff) {
        console.warn(`[ticket:${ticket.ticketId}] creator is staff, but bot has neither support role nor ticket role; skipped restrictive deny-all override.`);
      } else if (createdTicketRoleId && !creatorHasTicketRole) {
        console.warn(`[ticket:${ticket.ticketId}] ticket role exists but creator does not have it; skipped restrictive deny-all override to avoid lockout.`);
      } else {
        if (botCanStillAccess) {
          console.warn(`[ticket:${ticket.ticketId}] restrictive deny-all skipped (missing ticket role for creator) to avoid locking out creator.`);
        } else {
          console.warn(`[ticket:${ticket.ticketId}] restrictive deny-all skipped (missing ticket role or bot access safeguard) to avoid locking out creator/bot.`);
        }
      }

      console.log(`[ticket:${ticket.ticketId}] permission overrides applied`);
    } catch (permissionError) {
      console.error(`[ticket:${ticket.ticketId}] failed to apply permission overrides:`, getReadableError(permissionError));
    }

    // Move channel into the open tickets category.
    // On newly-created channels, category updates can be eventually consistent,
    // so retry a few times before giving up.
    const movedToOpenCategory = await retryMoveChannelToCategory({
      client,
      serverId: config.serverId,
      channelId: channel.id,
      categoryId: config.openTicketsCategoryId,
      attempts: 1,
      delayMs: 500,
      contextLabel: `[ticket:${ticket.ticketId}] open-category-move`,
    });

    if (movedToOpenCategory) {
      console.log(`[ticket:${ticket.ticketId}] moved to open category`);
    } else {
      scheduleDeferredCategoryMove({
        client,
        serverId: config.serverId,
        channelId: channel.id,
        categoryId: config.openTicketsCategoryId,
        contextLabel: `[ticket:${ticket.ticketId}] deferred-open-category-move`,
      });
    }

    // Access is controlled by per-ticket role + support role overrides above.
    
    console.log(`[ticket:${ticket.ticketId}] open flow complete`);
    await logTicketAction(client, {
      action: 'Ticket opened',
      ticketId: ticket.ticketId,
      executorId: userId,
      creatorId: userId,
      channelId: channel.id,
      reason: normalizedReason,
      details: responseChannel ? 'Opened by command or ticket panel reaction.' : 'Opened programmatically.',
    });
    
  } catch (error) {
    console.error('Error creating ticket channel:', error);

    if (createdTicketRoleId) {
      try {
        await server.roles.delete(createdTicketRoleId);
      } catch (cleanupRoleError) {
        console.error(`[ticket:${ticket.ticketId}] failed to cleanup ticket role after channel error:`, getReadableError(cleanupRoleError));
      }
    }

    ticketDb.update(ticket.ticketId, { status: 'error', error: error.message });
    await sendTicketOpenResponse({
      client,
      userId,
      responseChannel,
      content: '❌ Failed to create the ticket channel. Please contact an administrator.',
    });
  }
}

async function sendTicketOpenResponse({
  client,
  userId,
  responseChannel,
  content,
}: {
  client: any;
  userId: string;
  responseChannel?: any;
  content: string;
}): Promise<void> {
  try {
    let user = client.users?.cache?.get?.(userId) || null;
    if (!user) {
      user = await client.users?.fetch?.(userId).catch(() => null);
    }

    if (user) {
      // stoatbot.js usually requires a DM channel to exist first.
      // Creating/opening it explicitly is more reliable than user.send alone.
      if (typeof user.createDM === 'function') {
        const dmChannel = await user.createDM().catch(() => null);
        if (dmChannel?.send) {
          await dmChannel.send({ content });
          return;
        }
      }

      if (typeof user.send === 'function') {
        await user.send({ content });
        return;
      }
    }
  } catch (error) {
    console.warn(`Failed to send ticket open response in DM to ${userId}:`, getReadableError(error));
  }

  // Fallback in case DM is not available (privacy settings, blocked DMs, etc.)
  const fallbackMessage = await responseChannel?.send({ content });

  // Auto-clean fallback channel responses after 10s to reduce clutter.
  if (fallbackMessage?.delete) {
    setTimeout(() => {
      fallbackMessage.delete().catch(() => {
        // ignore: message may already be deleted or missing permissions
      });
    }, 10_000);
  }
}

const fullAccessPermissions = [
  'ViewChannel',
  'ReadMessageHistory',
  'SendMessage',
  'SendEmbeds',
  'UploadFiles',
  'React',
];

const denyAllPermissions = [
  'ViewChannel',
  'ReadMessageHistory',
  'SendMessage',
];

function extractRoleIds(roles: unknown): string[] {
  if (!roles) return [];

  if (Array.isArray(roles)) {
    return roles
      .map((role) => {
        if (typeof role === 'string') return role;
        if (role && typeof role === 'object') {
          return (role as any).id || (role as any)._id || null;
        }
        return null;
      })
      .filter((id): id is string => !!id);
  }

  if (roles instanceof Set) {
    return Array.from(roles).filter((id): id is string => typeof id === 'string');
  }

  if (roles instanceof Map) {
    return Array.from(roles.keys()).filter((id): id is string => typeof id === 'string');
  }

  return [];
}

function canAssignRoleByHierarchy(server: any, actorMember: any, targetMember: any, roleId: string): boolean | null {
  if (!server || !actorMember || !targetMember || !roleId) return null;

  if (actorMember === targetMember) {
    return false;
  }

  const roleMap = toRoleRankMap(server?.roles?.cache);
  if (!roleMap || roleMap.size === 0) return null;

  const actorRoleIds = extractRoleIds(actorMember?.roles);
  const targetRoleIds = extractRoleIds(targetMember?.roles);

  if (actorRoleIds.length === 0 || targetRoleIds.length === 0) return null;

  const actorHighest = highestRoleRank(actorRoleIds, roleMap);
  const targetHighest = highestRoleRank(targetRoleIds, roleMap);
  const roleRank = roleMap.get(roleId);

  if (!Number.isFinite(actorHighest) || !Number.isFinite(targetHighest) || !Number.isFinite(roleRank)) {
    return null;
  }

  // Stoat follows elevation semantics similar to Discord:
  // actor must be strictly higher than target's highest role and the role being assigned.
  return actorHighest > targetHighest && actorHighest > roleRank;
}

function toRoleRankMap(cacheLike: unknown): Map<string, number> {
  const map = new Map<string, number>();

  const values =
    cacheLike instanceof Map
      ? Array.from(cacheLike.values())
      : Array.isArray(cacheLike)
        ? cacheLike
        : [];

  for (const role of values) {
    const id = role?.id || role?._id;
    const rank = Number(role?.rank);
    if (typeof id === 'string' && Number.isFinite(rank)) {
      map.set(id, rank);
    }
  }

  return map;
}

function highestRoleRank(roleIds: string[], roleMap: Map<string, number>): number {
  let highest = Number.NEGATIVE_INFINITY;

  for (const id of roleIds) {
    const rank = roleMap.get(id);
    if (Number.isFinite(rank) && rank! > highest) {
      highest = rank!;
    }
  }

  return highest;
}

async function retryMoveChannelToCategory({
  client,
  serverId,
  channelId,
  categoryId,
  attempts = 3,
  delayMs = 800,
  contextLabel = 'category-move',
}: {
  client: any;
  serverId: string;
  channelId: string;
  categoryId: string;
  attempts?: number;
  delayMs?: number;
  contextLabel?: string;
}): Promise<boolean> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await moveChannelToCategory(client, serverId, channelId, categoryId);
      return true;
    } catch (error) {
      lastError = error;
      const detail = getReadableError(error);
      console.warn(`${contextLabel}: attempt ${attempt}/${attempts} failed: ${detail}`);

      if (attempt < attempts) {
        await sleep(delayMs * attempt);
      }
    }
  }

  console.error(`${contextLabel}: failed after ${attempts} attempts: ${getReadableError(lastError)}`);
  return false;
}

function scheduleDeferredCategoryMove({
  client,
  serverId,
  channelId,
  categoryId,
  contextLabel,
}: {
  client: any;
  serverId: string;
  channelId: string;
  categoryId: string;
  contextLabel: string;
}) {
  // Extra delayed retries help when newly created channels are not yet fully
  // visible to category-structure edits on Stoat's backend.
  setTimeout(() => {
    retryMoveChannelToCategory({
      client,
      serverId,
      channelId,
      categoryId,
      attempts: 2,
      delayMs: 900,
      contextLabel,
    }).then((ok) => {
      if (ok) {
        console.log(`${contextLabel}: success`);
      }
    }).catch((error) => {
      console.error(`${contextLabel}: unexpected failure`, getReadableError(error));
    });
  }, 1800);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}
