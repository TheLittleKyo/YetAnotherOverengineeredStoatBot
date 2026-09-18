import { config } from '../config.js';
import { disableLogChannel, getLogConfig, sendServerLog, setLogChannel } from '../log-system.js';
import { requirePermission } from '../permissions.js';
import { normalizeId } from '../id-utils.js';

// Which server this command targets. Log config is per-server, so a chat
// command must scope to the server the message came from — not the configured
// default — otherwise `!logs set` in one server would rewire another's logs.
function messageServerId(message: any): string {
  return message?.channel?.serverId || message?.serverId || message?.server?._id || message?.server?.id || config.serverId;
}

/**
 * Logs command
 * Usage:
 * !logs set <channelId>
 * !logs disable
 * !logs status
 * !logs test
 * !logs debug          ← NEW: fetches a member and dumps its raw shape
 */
export async function logsCommand(message, args, client) {
  const sub = (args.shift() || '').toLowerCase();
  const serverId = messageServerId(message);

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  // `status` and `help` are safe for everyone; mutating subcommands need ManageServer.
  if (sub !== 'status') {
    if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;
  }

  if (sub === 'set') {
    const channelId = normalizeId(args.shift());
    if (!channelId) {
      await message.channel?.send({
        content: `❌ Usage: \`${config.prefix}logs set <channelId>\``,
      });
      return;
    }

    setLogChannel(channelId, serverId);
    await message.channel?.send({
      content: `✅ Log channel set to <#${channelId}>.`,
    });
    return;
  }

  if (sub === 'disable') {
    disableLogChannel(serverId);
    await message.channel?.send({
      content: `✅ Logs disabled.`,
    });
    return;
  }

  if (sub === 'status') {
    const state = getLogConfig(serverId);
    await message.channel?.send({
      content:
        `# 🧾 Log System Status\n\n` +
        `**Enabled:** ${state.enabled ? 'Yes' : 'No'}\n` +
        `**Channel:** ${state.channelId ? `<#${state.channelId}>` : 'Not set'}`,
    });
    return;
  }

  if (sub === 'test') {
    const ok = await sendServerLog(client, {
      title: 'Log System Test',
      colour: '#22c55e',
      description: `This is a test log message from \`${config.prefix}logs test\`.`,
    }, serverId);

    await message.channel?.send({
      content: ok ? '✅ Test log sent.' : '❌ Failed to send test log (is log channel configured?).',
    });
    return;
  }

  if (sub === 'debug') {
    // `debug` dumps member internals — already gated above by ManageServer.
    await debugMemberShape(message, client);
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  await sendHelp(message);
}

async function debugMemberShape(message, client) {
  try {
    let server = null;
    try {
      server = await client.servers.fetch(config.serverId);
    } catch {
      server = client.servers.cache.get(config.serverId);
    }

    if (!server) {
      await message.channel?.send({ content: '❌ Could not fetch server.' });
      return;
    }

    const member = await server.members.fetch(message.authorId).catch(() => null);
    if (!member) {
      await message.channel?.send({ content: '❌ Could not fetch your member object.' });
      return;
    }

    // Collect every field name + its type/value (truncated for safety)
    const shape: Record<string, string> = {};
    for (const key of Object.keys(member)) {
      const val = (member as any)[key];
      if (val === null) {
        shape[key] = 'null';
      } else if (Array.isArray(val)) {
        shape[key] = `Array(${val.length}) → ${JSON.stringify(val.slice(0, 3))}${val.length > 3 ? '…' : ''}`;
      } else if (val instanceof Set) {
        const arr = Array.from(val);
        shape[key] = `Set(${arr.length}) → ${JSON.stringify(arr.slice(0, 3))}${arr.length > 3 ? '…' : ''}`;
      } else if (val instanceof Map) {
        shape[key] = `Map(${val.size}) keys → ${JSON.stringify(Array.from(val.keys()).slice(0, 3))}`;
      } else if (typeof val === 'object') {
        try {
          const str = JSON.stringify(val);
          shape[key] = str.length > 120 ? str.slice(0, 117) + '…' : str;
        } catch {
          shape[key] = `[object] keys=${Object.keys(val).join(',')}`;
        }
      } else {
        shape[key] = String(val);
      }
    }

    // Log to console (full fidelity)
    console.log('[debug] member shape:', JSON.stringify(shape, null, 2));

    // Send summary to channel
    const lines = Object.entries(shape).map(([k, v]) => `\`${k}\`: ${v}`);
    const chunks = chunkLines(lines, 1800);

    await message.channel?.send({
      content: `# 🔍 Member Object Shape (${Object.keys(shape).length} keys)\n\nAlso printed in full to the bot console.\n\n` + chunks[0],
    });
    for (let i = 1; i < chunks.length; i++) {
      await message.channel?.send({ content: chunks[i] });
    }
  } catch (error) {
    console.error('[debug] member shape error:', error);
    await message.channel?.send({
      content: `❌ Debug failed: ${error?.message || error}`,
    });
  }
}

function chunkLines(lines: string[], maxLen: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendHelp(message) {
  await message.channel?.send({
    content:
      `# 🧾 Logs Help\n\n` +
      `\`${config.prefix}logs set <channelId>\` - Set log channel\n` +
      `\`${config.prefix}logs status\` - Show log status\n` +
      `\`${config.prefix}logs test\` - Send test log\n` +
      `\`${config.prefix}logs disable\` - Disable logging\n` +
      `\`${config.prefix}logs debug\` - Dump your member object shape (for diagnostics)`,
  });
}
