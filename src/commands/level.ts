import { config } from '../config.js';
import { requirePermission } from '../permissions.js';
import {
  addRoleReward,
  addUserXp,
  clearRoleRewards,
  getLeaderboard,
  getLevelingConfig,
  getLevelProgress,
  getRoleRewards,
  getTrackedUserCount,
  getUserRank,
  removeRoleReward,
  resetAll,
  resetUser,
  setLevelingConfig,
  setUserLevel,
  setUserXp,
  type LevelingConfig,
} from '../leveling.js';

/**
 * `!level` / `!rank` / `!leaderboard` — leveling + leaderboard commands.
 *
 * Everyone: rank card + leaderboard. Admins (Manage Server): full config,
 * role rewards (auto-add roles per level), and XP adjustments.
 */
export async function levelCommand(message, args, client) {
  const sub = String(args[0] || '').toLowerCase();

  // Bare invocation / explicit rank view.
  if (!sub || sub === 'rank' || sub === 'me') {
    const target = sub && sub !== 'me' ? normalizeUserId(args[1]) : normalizeUserId(args[0]);
    await showRank(message, target || resolveAuthorId(message));
    return;
  }

  if (sub === 'leaderboard' || sub === 'lb' || sub === 'top' || sub === 'ranks') {
    await showLeaderboard(message, args[1]);
    return;
  }

  if (sub === 'help') {
    await sendHelp(message);
    return;
  }

  // Everything below mutates config/XP → require Manage Server.
  if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;

  const rest = args.slice(1);

  switch (sub) {
    case 'enable':
      setLevelingConfig({ enabled: true });
      await reply(message, '✅ Leveling **enabled**. Members now earn XP for chatting.');
      return;

    case 'disable':
      setLevelingConfig({ enabled: false });
      await reply(message, '✅ Leveling **disabled**. No XP will be awarded.');
      return;

    case 'setxp':
    case 'xprate': {
      const min = Math.floor(Number(rest[0]));
      const max = Math.floor(Number(rest[1]));
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
        await reply(message, `❌ Usage: \`${config.prefix}level setxp <min> <max>\` (0 ≤ min ≤ max).`);
        return;
      }
      const cfg = setLevelingConfig({ xpMin: min, xpMax: max });
      await reply(message, `✅ XP per message set to **${cfg.xpMin}–${cfg.xpMax}**.`);
      return;
    }

    case 'cooldown': {
      const seconds = Math.floor(Number(rest[0]));
      if (!Number.isFinite(seconds) || seconds < 0) {
        await reply(message, `❌ Usage: \`${config.prefix}level cooldown <seconds>\`.`);
        return;
      }
      const cfg = setLevelingConfig({ cooldownSeconds: seconds });
      await reply(message, `✅ XP cooldown set to **${cfg.cooldownSeconds}s** between messages.`);
      return;
    }

    case 'stack': {
      const on = parseBool(rest[0]);
      if (on === null) {
        await reply(message, `❌ Usage: \`${config.prefix}level stack <on|off>\`. On = keep every earned role; off = keep only the highest.`);
        return;
      }
      const cfg = setLevelingConfig({ stackRoles: on });
      await reply(message, `✅ Reward role stacking **${cfg.stackRoles ? 'on' : 'off'}**.`);
      return;
    }

    case 'announce': {
      const value = String(rest[0] || '').toLowerCase();
      if (value === 'off' || value === 'false' || value === 'disable') {
        setLevelingConfig({ announce: false });
        await reply(message, '✅ Level-up announcements **off**.');
        return;
      }
      if (value === 'on' || value === 'true' || value === 'enable' || value === 'here') {
        const patch: Partial<LevelingConfig> = { announce: true };
        if (value === 'here') patch.announceChannelId = resolveChannelId(message);
        const cfg = setLevelingConfig(patch);
        await reply(message, `✅ Level-up announcements **on**${cfg.announceChannelId ? ` in <#${cfg.announceChannelId}>` : ' in the channel where the level-up happens'}.`);
        return;
      }
      const channelId = normalizeChannelId(rest[0]);
      if (channelId) {
        const cfg = setLevelingConfig({ announce: true, announceChannelId: channelId });
        await reply(message, `✅ Level-up announcements **on** in <#${cfg.announceChannelId}>.`);
        return;
      }
      await reply(message, `❌ Usage: \`${config.prefix}level announce <on|off|here|#channelId>\`.`);
      return;
    }

    case 'rolereward':
    case 'reward':
    case 'rewards':
    case 'rr': {
      await handleRoleReward(message, rest);
      return;
    }

    case 'givexp':
    case 'addxp': {
      const userId = normalizeUserId(rest[0]);
      const amount = Math.floor(Number(rest[1]));
      if (!userId || !Number.isFinite(amount)) {
        await reply(message, `❌ Usage: \`${config.prefix}level givexp <@user> <amount>\` (amount may be negative).`);
        return;
      }
      const progress = addUserXp(userId, amount);
      await reply(message, `✅ <@${userId}> now has **${progress.xp} XP** (Level ${progress.level}).`);
      return;
    }

    case 'setxpuser':
    case 'setuserxp': {
      const userId = normalizeUserId(rest[0]);
      const amount = Math.floor(Number(rest[1]));
      if (!userId || !Number.isFinite(amount) || amount < 0) {
        await reply(message, `❌ Usage: \`${config.prefix}level setuserxp <@user> <xp>\`.`);
        return;
      }
      const progress = setUserXp(userId, amount);
      await reply(message, `✅ Set <@${userId}> to **${progress.xp} XP** (Level ${progress.level}).`);
      return;
    }

    case 'setlevel': {
      const userId = normalizeUserId(rest[0]);
      const level = Math.floor(Number(rest[1]));
      if (!userId || !Number.isFinite(level) || level < 0) {
        await reply(message, `❌ Usage: \`${config.prefix}level setlevel <@user> <level>\`.`);
        return;
      }
      const progress = setUserLevel(userId, level);
      await reply(message, `✅ Set <@${userId}> to **Level ${progress.level}** (${progress.xp} XP).`);
      return;
    }

    case 'reset': {
      const targetRaw = String(rest[0] || '').toLowerCase();
      if (targetRaw === 'all' || targetRaw === 'everyone') {
        resetAll();
        await reply(message, '✅ Reset **all** leveling data for this server.');
        return;
      }
      const userId = normalizeUserId(rest[0]);
      if (!userId) {
        await reply(message, `❌ Usage: \`${config.prefix}level reset <@user|all>\`.`);
        return;
      }
      const ok = resetUser(userId);
      await reply(message, ok ? `✅ Reset leveling data for <@${userId}>.` : `ℹ️ <@${userId}> had no leveling data.`);
      return;
    }

    case 'config':
    case 'settings':
    case 'status':
      await showConfig(message);
      return;

    default:
      await sendHelp(message);
  }
}

async function handleRoleReward(message, rest: string[]) {
  const action = String(rest[0] || '').toLowerCase();

  if (action === 'add' || action === 'set') {
    const level = Math.floor(Number(rest[1]));
    const roleId = normalizeRoleId(rest[2]);
    if (!Number.isFinite(level) || level < 1 || !roleId) {
      await reply(message, `❌ Usage: \`${config.prefix}level rolereward add <level> <roleId>\`.`);
      return;
    }
    addRoleReward(level, roleId);
    await reply(message, `✅ Members reaching **Level ${level}** will now be auto-assigned <%${roleId}>.`);
    return;
  }

  if (action === 'remove' || action === 'delete') {
    const level = Math.floor(Number(rest[1]));
    if (!Number.isFinite(level) || level < 1) {
      await reply(message, `❌ Usage: \`${config.prefix}level rolereward remove <level>\`.`);
      return;
    }
    removeRoleReward(level);
    await reply(message, `✅ Removed the Level ${level} role reward.`);
    return;
  }

  if (action === 'clear') {
    clearRoleRewards();
    await reply(message, '✅ Cleared all role rewards.');
    return;
  }

  // Default: list.
  const rewards = getRoleRewards();
  if (rewards.length === 0) {
    await reply(message, `ℹ️ No role rewards configured. Add one with \`${config.prefix}level rolereward add <level> <roleId>\`.`);
    return;
  }
  const lines = rewards.map((r) => `• **Level ${r.level}** → <%${r.roleId}>`);
  await reply(message, `# 🏅 Role Rewards\n\n${lines.join('\n')}`);
}

async function showRank(message, userId: string | null) {
  if (!userId) {
    await reply(message, '❌ Could not resolve that user.');
    return;
  }

  const row = getUserRank(userId);
  if (!row) {
    await reply(message, `ℹ️ <@${userId}> hasn't earned any XP yet.`);
    return;
  }

  const progress = getLevelProgress(row.xp);
  const bar = renderProgressBar(progress.currentLevelXp, progress.neededForNext);

  await reply(
    message,
    `# 📊 Rank — ${escapeName(row.name)}\n\n` +
      `**Rank:** #${row.rank} of ${getTrackedUserCount()}\n` +
      `**Level:** ${progress.level}\n` +
      `**XP:** ${progress.currentLevelXp} / ${progress.neededForNext} (this level)\n` +
      `**Total XP:** ${row.xp}\n\n` +
      `${bar}`,
  );
}

async function showLeaderboard(message, limitArg) {
  const limit = Math.max(1, Math.min(25, Math.floor(Number(limitArg)) || 10));
  const rows = getLeaderboard(limit);

  if (rows.length === 0) {
    await reply(message, 'ℹ️ No one has earned XP yet. Start chatting!');
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((row) => {
    const marker = medals[row.rank - 1] || `**#${row.rank}**`;
    return `${marker} ${escapeName(row.name)} — Level ${row.level} · ${row.xp} XP`;
  });

  await reply(message, `# 🏆 Leaderboard\n\n${lines.join('\n')}`);
}

async function showConfig(message) {
  const cfg = getLevelingConfig();
  const rewards = getRoleRewards();
  const rewardText = rewards.length
    ? rewards.map((r) => `Lvl ${r.level} → <%${r.roleId}>`).join(', ')
    : 'none';

  await reply(
    message,
    `# ⚙️ Leveling Settings\n\n` +
      `**Enabled:** ${cfg.enabled ? 'yes' : 'no'}\n` +
      `**XP per message:** ${cfg.xpMin}–${cfg.xpMax}\n` +
      `**Cooldown:** ${cfg.cooldownSeconds}s\n` +
      `**Announcements:** ${cfg.announce ? (cfg.announceChannelId ? `on (<#${cfg.announceChannelId}>)` : 'on (level-up channel)') : 'off'}\n` +
      `**Role stacking:** ${cfg.stackRoles ? 'on' : 'off'}\n` +
      `**Role rewards:** ${rewardText}\n` +
      `**Tracked members:** ${getTrackedUserCount()}`,
  );
}

async function sendHelp(message) {
  await reply(
    message,
    `# 📈 Leveling Help\n\n` +
      `**Everyone**\n` +
      `\`${config.prefix}rank [@user]\` — Show a rank card.\n` +
      `\`${config.prefix}leaderboard [count]\` — Show the top members.\n\n` +
      `**Admin (Manage Server)**\n` +
      `\`${config.prefix}level enable | disable\` — Turn leveling on/off.\n` +
      `\`${config.prefix}level setxp <min> <max>\` — XP awarded per message.\n` +
      `\`${config.prefix}level cooldown <seconds>\` — Anti-spam XP cooldown.\n` +
      `\`${config.prefix}level announce <on|off|here|#channelId>\` — Level-up messages.\n` +
      `\`${config.prefix}level stack <on|off>\` — Keep all reward roles, or only the highest.\n` +
      `\`${config.prefix}level rolereward add <level> <roleId>\` — Auto-add a role at a level.\n` +
      `\`${config.prefix}level rolereward remove <level>\` — Remove a role reward.\n` +
      `\`${config.prefix}level rolereward list\` — List role rewards.\n` +
      `\`${config.prefix}level givexp <@user> <amount>\` — Grant/remove XP.\n` +
      `\`${config.prefix}level setlevel <@user> <level>\` — Set a member's level.\n` +
      `\`${config.prefix}level reset <@user|all>\` — Reset leveling data.\n` +
      `\`${config.prefix}level config\` — Show current settings.`,
  );
}

function renderProgressBar(current: number, total: number, width = 20): string {
  const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  return `\`${bar}\` ${Math.round(ratio * 100)}%`;
}

async function reply(message, content: string) {
  await message.channel?.send({ content });
}

function resolveAuthorId(message): string | null {
  const id = message?.authorId || message?.author?.id || message?.author?._id;
  return id ? String(id) : null;
}

function resolveChannelId(message): string | null {
  const id = message?.channelId || message?.channel_id || message?.channel?.id || message?.channel?._id;
  return id ? String(id) : null;
}

function escapeName(name: string): string {
  // Prevent stored display names from injecting markdown headings/mentions.
  return String(name || 'Unknown').replace(/[\r\n]+/g, ' ').replace(/[`*_~|<>@#]/g, '').slice(0, 48) || 'Unknown';
}

function parseBool(value): boolean | null {
  const v = String(value || '').toLowerCase();
  if (['on', 'true', 'yes', 'enable', '1'].includes(v)) return true;
  if (['off', 'false', 'no', 'disable', '0'].includes(v)) return false;
  return null;
}

function normalizeUserId(value): string | null {
  const input = String(value || '').trim();
  if (!input) return null;
  const mentionMatch = input.match(/^<@!?([A-Za-z0-9_-]+)>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];
  const atMatch = input.match(/^@([A-Za-z0-9_-]+)$/);
  if (atMatch?.[1]) return atMatch[1];
  if (/^[A-Za-z0-9_-]+$/.test(input)) return input;
  return null;
}

function normalizeRoleId(value): string | null {
  const input = String(value || '').trim();
  if (!input) return null;
  const tagMatch = input.match(/^(?:<%([A-Za-z0-9_-]+)>|%([A-Za-z0-9_-]+))$/);
  if (tagMatch?.[1] || tagMatch?.[2]) return tagMatch[1] || tagMatch[2];
  const mentionMatch = input.match(/^<[@#&%]?([A-Za-z0-9_-]+)>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];
  if (/^[A-Za-z0-9_-]+$/.test(input)) return input;
  return null;
}

function normalizeChannelId(value): string | null {
  const input = String(value || '').trim();
  if (!input) return null;
  const mentionMatch = input.match(/^<#([A-Za-z0-9_-]+)>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];
  const hashMatch = input.match(/^#([A-Za-z0-9_-]+)$/);
  if (hashMatch?.[1]) return hashMatch[1];
  if (/^[A-Za-z0-9_-]+$/.test(input)) return input;
  return null;
}
