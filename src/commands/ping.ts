import os from 'node:os';
import { config } from '../config.js';

/**
 * Ping / health command
 *
 * Measures round-trip message latency, Stoat API latency, and reports host
 * hardware status: CPU load, memory usage, and process/system uptime.
 *
 * Usage: !ping
 */
export async function pingCommand(message, args, client) {
  const start = Date.now();

  const sent = await message.channel?.send({ content: '🏓 Pinging...' });
  const messageLatency = Date.now() - start;

  const apiLatency = await measureApiLatency(client);
  const cpuPercent = await sampleProcessCpuPercent(150);

  const report = renderReport({ messageLatency, apiLatency, cpuPercent, client });

  if (sent && typeof sent.edit === 'function') {
    await sent.edit({ content: report });
  } else {
    await message.channel?.send({ content: report });
  }
}

function renderReport({ messageLatency, apiLatency, cpuPercent, client }) {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpus = os.cpus() || [];
  const cpuModel = cpus[0]?.model?.trim() || 'Unknown CPU';
  const serverCount = safeNumber(client?.servers?.cache?.size);

  const apiLatencyText = apiLatency === null ? 'unavailable' : `${apiLatency} ms`;

  return (
    `# 🏓 ${config.botName} Status\n\n` +
    `**Latency**\n` +
    `• Message round-trip: \`${messageLatency} ms\`\n` +
    `• Stoat API: \`${apiLatencyText}\`\n\n` +
    `**Hardware**\n` +
    `• CPU: \`${cpuPercent}%\` process load — ${cpus.length}x ${cpuModel}\n` +
    `• Process RAM (RSS): \`${formatBytes(mem.rss)}\` (heap ${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)})\n` +
    `• System RAM: \`${formatBytes(usedMem)}\` / \`${formatBytes(totalMem)}\` used (${percent(usedMem, totalMem)}%)\n\n` +
    `**Runtime**\n` +
    `• Bot uptime: \`${formatUptime(process.uptime())}\`\n` +
    `• Host uptime: \`${formatUptime(os.uptime())}\`\n` +
    `• Node: \`${process.version}\` on \`${os.platform()} ${os.arch()}\`\n` +
    `• Servers connected: \`${serverCount}\``
  );
}

async function measureApiLatency(client) {
  const endpoints = ['/users/@me', '/'];
  for (const endpoint of endpoints) {
    if (typeof client?.api?.get !== 'function') break;
    const start = Date.now();
    try {
      await client.api.get(endpoint);
      return Date.now() - start;
    } catch {
      // try next endpoint
    }
  }
  return null;
}

/**
 * Sample process CPU usage over a short window and return a percentage of a
 * single core's capacity (can exceed 100% on multi-threaded work).
 */
function sampleProcessCpuPercent(windowMs) {
  return new Promise((resolve) => {
    const startUsage = process.cpuUsage();
    const startTime = Date.now();

    setTimeout(() => {
      const elapsedUs = (Date.now() - startTime) * 1000;
      const diff = process.cpuUsage(startUsage);
      const totalUs = diff.user + diff.system;
      const pct = elapsedUs > 0 ? (totalUs / elapsedUs) * 100 : 0;
      resolve(Math.round(pct * 10) / 10);
    }, windowMs);
  });
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = size >= 100 || unit === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

function formatUptime(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

function percent(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}
