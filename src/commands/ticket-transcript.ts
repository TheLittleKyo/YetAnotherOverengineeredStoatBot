import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { File as NodeFile } from 'node:buffer';
import { MessageEmbed } from 'stoatbot.js';
import { config } from '../config.js';
import { ticketDb } from '../database.js';
import { isTicketStaff } from '../permissions.js';
import { generateTranscript } from '../transcript.js';
import { logTicketAction } from '../log-system.js';
import { captureTicketPermissionSnapshot } from '../permission-snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = join(__dirname, '..', '..', 'temp');

/**
 * Generate a transcript for a closed ticket
 * Usage: !ticket transcript
 * Must be used inside a closed ticket channel
 */
export async function ticketTranscript(message, args, client) {
  // Get the ticket for this channel
  const ticket = ticketDb.getByChannelId(message.channelId);

  if (!ticket) {
    await message.channel?.send({
      content: '❌ This command can only be used inside a ticket channel.',
    });
    return;
  }

  if (ticket.status !== 'closed') {
    await message.channel?.send({
      content:
        `❌ Transcripts can only be generated for closed tickets. Please close the ticket first with \`${config.prefix}ticket close\`.`,
    });
    return;
  }

  // Check if user has permission
  const isCreator = message.authorId === ticket.creatorId;
  let server = null;
  try {
    server = await client.servers.fetch(config.serverId);
  } catch {
    server = client.servers.cache.get(config.serverId);
  }
  const member = await server?.members?.fetch(message.authorId).catch(() => server?.members?.cache?.get?.(message.authorId) || null);
  const isStaff = await isTicketStaff(client, config.serverId, message.authorId, member, config.supportRoleId);

  if (!isCreator && !isStaff) {
    await message.channel?.send({
      content: '❌ Only the ticket creator or support staff can generate transcripts.',
    });
    return;
  }

  await message.channel?.send({
    content: '📝 Generating transcript... This may take a moment.',
  });

  try {
    const generated = await generateAndSendTranscriptForTicket({
      client,
      sourceChannelId: message.channelId,
      ticket,
      generatedById: message.authorId,
      generatedByUsername: message.author?.username || 'Unknown User',
      generatedForAction: 'manual transcript command',
    });

    if (!generated.ok) {
      await message.channel?.send({
        content: `❌ ${generated.error || 'Failed to generate transcript.'}`,
      });
      return;
    }

    await message.channel?.send({
      content: `✅ Transcript generated and sent to the log channel!`,
    });
    await logTicketAction(client, {
      action: 'Ticket transcript generated',
      ticketId: ticket.ticketId,
      executorId: message.authorId,
      creatorId: ticket.creatorId,
      channelId: message.channelId,
      details: 'Manual transcript command completed successfully.',
    });
  } catch (error) {
    console.error('Error generating transcript:', error);
    await message.channel?.send({
      content: '❌ Failed to generate transcript. Please try again or contact an administrator.',
    });
  }
}

/**
 * Generate and send transcript artifacts to transcript channel.
 * Produces a single HTML transcript file.
 * The HTML includes a markdown-compatible block + full DB snapshot.
 */
export async function generateAndSendTranscriptForTicket({
  client,
  sourceChannelId,
  ticket,
  generatedById,
  generatedByUsername,
  generatedForAction,
}) {
  try {
    console.log(`[ticket:${ticket.ticketId}] transcript: started (${generatedForAction})`);

    const channel = client.channels.cache.get(sourceChannelId) || (await client.channels.fetch(sourceChannelId).catch(() => null));
    if (!channel) {
      return { ok: false, error: 'Could not find the ticket channel to generate transcript.' };
    }

    const messagesData = await fetchAllMessages(channel);
    console.log(`[ticket:${ticket.ticketId}] transcript: fetched ${messagesData.length} messages`);

    const serverRoles = await getServerRoleLabelMap(client);
    const serverChannels = getServerChannelLabelMap(client);

    const messages = await Promise.all(messagesData.map(async (msg) => {
      const author = await resolveMessageAuthor(msg, client);
      const member = await resolveMessageMember(msg, client);

      return {
        id: msg.id,
        content: msg.content || '',
        username: msg.username || member?.nickname || author?.username || msg.masquerade?.name || 'Unknown User',
        avatarUrl: await getMessageAvatarUrl(msg, member, author, client),
        createdAt: msg.createdAt,
        editedAt: msg.editedAt,
        authorId: msg.authorId,
        isSystem: !!msg.systemMessage,
        isBot: isBotAuthor(msg, member, author),
        systemContent: getSystemMessageContent(msg.systemMessage),
        replyIds: msg.replyIds || [],
        roleMentionIds: msg.roleMentionIds || [],
        attachments:
          msg.attachments?.map((att) => ({
            filename: att.filename || att.name,
            // Prefer originalUrl: previewUrl on Stoat's CDN is a resized static thumbnail
            // that strips GIF animation and returns a still frame for videos.
            // createFileURL() (no params) returns the unprocessed original file URL.
            url: getAttachmentUrl(att),
            fallbackUrls: getAttachmentFallbackUrls(att),
            size: att.size,
            contentType: att.contentType || att.content_type || att.type || att.metadata?.type,
          })) || [],
        embeds:
          msg.embeds?.map((emb) => ({
            type: emb.type,
            title: emb.title,
            description: emb.description,
            url: emb.url,
            originalUrl: emb.originalUrl,
            imageUrl: emb.image?.url || emb.image?.proxiedURL,
            videoUrl: emb.video?.url || emb.video?.proxiedURL,
            mediaUrl:
              emb.media?.originalUrl ||
              emb.media?.url ||
              (typeof emb.media?.createFileURL === 'function' ? emb.media.createFileURL() : null) ||
              emb.media?.previewUrl ||
              null,
          })) || [],
        roleLabels: {
          ...serverRoles,
          ...getMessageRoleLabelMap(msg),
        },
        channelLabels: serverChannels,
      };
    }));

    messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Capture the channel + participant permissions as they stand at transcript
    // time ("after"). Paired with ticket.permsBeforeClose ("before") this lets
    // the transcript show how access changed across the ticket's lifetime.
    let permsAtTranscript = null;
    try {
      permsAtTranscript = await captureTicketPermissionSnapshot(client, channel, ticket, 'At transcript');
    } catch (snapshotError) {
      console.warn(`[ticket:${ticket.ticketId}] transcript: permission snapshot failed:`, snapshotError?.message || snapshotError);
    }

    // Use the creator's own message avatar for the ticket-info header, if present.
    const creatorAvatarUrl =
      messages.find((m) => m.authorId && ticket.creatorId && String(m.authorId) === String(ticket.creatorId))?.avatarUrl || null;

    ensureTempDir();
    const now = Date.now();

    const html = generateTranscript(ticket, messages, {
      permsBeforeClose: ticket.permsBeforeClose || null,
      permsAtTranscript,
      creatorAvatarUrl,
    });

    const htmlFilename = `transcript-${ticket.ticketId}-${now}.html`;
    const htmlPath = join(TEMP_DIR, htmlFilename);
    writeFileSync(htmlPath, html, 'utf-8');

    let transcriptChannel = client.channels.cache.get(config.transcriptChannelId);
    if (!transcriptChannel) {
      try {
        transcriptChannel = await client.channels.fetch(config.transcriptChannelId);
      } catch {
        // keep null
      }
    }
    if (!transcriptChannel) {
      cleanupFile(htmlPath);
      return { ok: false, error: 'Could not find the transcript log channel. Please contact an administrator.' };
    }

    try {
      // Node 26 types: Buffer<ArrayBufferLike> isn't assignable to BlobPart.
      const htmlBytes = new Uint8Array(readFileSync(htmlPath));
      const htmlFile = new NodeFile([htmlBytes], htmlFilename, {
        type: 'text/html',
      });

      const transcriptEmbed = new MessageEmbed()
        .setTitle('📋 Ticket Transcript')
        .setDescription(
          (() => {
            const creatorDisplay = ticket.creatorId
              ? `<@${ticket.creatorId}> (${ticket.creatorId})`
              : ticket.creatorUsername || 'Unknown';

            const closedByDisplay = ticket.closedBy
              ? `<@${ticket.closedBy}> (${ticket.closedBy})`
              : ticket.closedByUsername || 'Unknown';

            const channelId = ticket.channelId || sourceChannelId;
            const channelDisplay = channelId
              ? `<#${channelId}> (${channelId})`
              : 'Unknown';

            const generatedByDisplay = generatedById
              ? `<@${generatedById}> (${generatedById})`
              : generatedByUsername || 'Unknown';

            return (
          `**Ticket:** #${ticket.ticketId}\n` +
          `**Creator:** ${creatorDisplay}\n` +
          `**Status:** ${ticket.status || 'unknown'}\n` +
          `**Reason:** ${ticket.reason || 'No reason provided'}\n` +
          `**Opened at:** ${ticket.createdAt ? new Date(ticket.createdAt).toLocaleString() : 'Unknown'}\n` +
          `**Closed at:** ${ticket.closedAt ? new Date(ticket.closedAt).toLocaleString() : 'Not closed'}\n` +
          `**Closed by:** ${closedByDisplay}\n` +
          `**Channel ID:** ${channelDisplay}\n` +
          `**Generated by:** ${generatedByDisplay}\n` +
          `**Context:** ${generatedForAction || 'manual transcript'}\n` +
          `**Message count:** ${messages.length}\n\n`
            );
          })()
        )
        .setColor('#3b82f6');

      await transcriptChannel.send({
        embeds: [transcriptEmbed],
        attachments: [htmlFile],
      });

      cleanupFile(htmlPath);
      console.log(`[ticket:${ticket.ticketId}] transcript: sent to log channel`);
      return { ok: true, messagesCount: messages.length };
    } catch (uploadError) {
      console.error('Error uploading transcript:', uploadError);

      const fallback = buildPlainTextTranscript(ticket, messages);
      const chunks = chunkText(fallback, 1800).slice(0, 6);

      const fallbackEmbed = new MessageEmbed()
        .setTitle('📋 Ticket Transcript (Text Fallback)')
        .setDescription(
          `**Ticket:** #${ticket.ticketId}\n` +
          `**Context:** ${generatedForAction || 'manual transcript'}\n` +
          `**Message count:** ${messages.length}\n\n` +
          `File upload failed, sending transcript text in chunks.`
        )
        .setColor('#f59e0b');

      await transcriptChannel.send({
        embeds: [fallbackEmbed],
      });

      for (let index = 0; index < chunks.length; index++) {
        await transcriptChannel.send({
          content: `Transcript chunk ${index + 1}/${chunks.length}\n\n\`\`\`\n${chunks[index]}\n\`\`\``,
        });
      }

      return { ok: false, error: 'Transcript files upload failed. Fallback text was sent to transcript channel.' };
    }
  } catch (error) {
    console.error('Error generating transcript package:', error);
    return { ok: false, error: 'Failed to generate transcript package.' };
  }
}

/**
 * Legacy helper retained only for backwards compatibility notes.
 * Upload IDs cannot be passed directly to stoatbot.js `attachments` as strings,
 * because strings are treated as URLs and re-fetched.
 */
async function uploadFileToAutumn(client, filePath, filename, tag = 'attachments', mimeType = 'text/plain') {
  void client;
  void filePath;
  void filename;
  void tag;
  void mimeType;
  throw new Error('Direct Autumn upload helper is disabled. Use channel.send({ attachments: [File] }) instead.');
}

function extractFileId(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object') {
    if (typeof payload.id === 'string') return payload.id;
    if (typeof payload._id === 'string') return payload._id;
    if (typeof payload.fileId === 'string') return payload.fileId;
    if (typeof payload.file_id === 'string') return payload.file_id;
    if (typeof payload.tag === 'string') return payload.tag;
    if (payload.id && typeof payload.id === 'object') {
      return payload.id.id || payload.id._id || null;
    }
    if (payload._id && typeof payload._id === 'object') {
      return payload._id.id || payload._id._id || null;
    }
    return null;
  }
  return null;
}

function truncate(text, maxLength) {
  const value = String(text || '');
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function buildPlainTextTranscript(ticket, messages) {
  const header = [
    `Ticket #${ticket.ticketId}`,
    `Created by: ${ticket.creatorUsername}`,
    `Closed by: ${ticket.closedByUsername || 'Unknown'}`,
    `Reason: ${ticket.reason || 'N/A'}`,
    `Messages: ${messages.length}`,
    '---',
  ].join('\n');

  const body = messages
    .map((msg) => {
      const timestamp = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : 'Unknown time';
      const author = msg.username || 'Unknown User';
      const content = String(msg.content || msg.systemContent || '[no content]').replace(/\r?\n/g, ' ');
      return `[${timestamp}] ${author}: ${content}`;
    })
    .join('\n');

  return `${header}\n${body}`;
}

function chunkText(text, maxChunkLength = 1800) {
  const value = String(text || '');
  if (!value) return [''];

  const chunks = [];
  let remaining = value;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxChunkLength);
    if (splitAt < Math.floor(maxChunkLength * 0.5)) {
      splitAt = maxChunkLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  return chunks;
}

async function getServerRoleLabelMap(client) {
  const labels = {};

  try {
    let server = null;
    try {
      server = await client.servers.fetch(config.serverId);
    } catch {
      server = client.servers.cache.get(config.serverId);
    }

    const rolesSource = server?.roles?.cache || server?.roles;
    const roles = rolesSource instanceof Map
      ? Array.from(rolesSource.values())
      : Array.isArray(rolesSource)
        ? rolesSource
        : rolesSource && typeof rolesSource === 'object'
          ? Object.entries(rolesSource).map(([id, role]) => ({ id, ...(role as any) }))
          : [];

    for (const role of roles) {
      const id = role?.id || role?._id;
      const name = role?.name;
      if (id && name) {
        labels[id] = name;
      }
    }
  } catch (error) {
    console.warn('Could not build transcript role label map:', error?.message || error);
  }

  return labels;
}

function getMessageRoleLabelMap(message) {
  const labels = {};
  const roleMentions = Array.isArray(message?.roleMentions) ? message.roleMentions : [];

  for (const role of roleMentions) {
    const id = role?.id || role?._id;
    const name = role?.name;
    if (id && name) {
      labels[id] = name;
    }
  }

  return labels;
}

function getServerChannelLabelMap(client) {
  const labels = {};

  try {
    const server = client?.servers?.cache?.get?.(config.serverId);
    const channelsSource = server?.channels?.cache || server?.channels || client?.channels?.cache;
    const channels = channelsSource instanceof Map
      ? Array.from(channelsSource.values())
      : Array.isArray(channelsSource)
        ? channelsSource
        : channelsSource && typeof channelsSource === 'object'
          ? Object.entries(channelsSource).map(([id, channel]) => ({ id, ...(channel as any) }))
          : [];

    for (const channel of channels) {
      const id = channel?.id || channel?._id;
      const name = channel?.name || channel?.displayName;
      if (id && name) {
        labels[id] = String(name).replace(/^#/, '');
      }
    }
  } catch (error) {
    console.warn('Could not build transcript channel label map:', error?.message || error);
  }

  return labels;
}

/**
 * Whether the message was sent by a bot. Stoat/Revolt users carry a truthy
 * `bot` object ({ owner }) when they are bots; webhook messages count too.
 */
function isBotAuthor(message, member, author): boolean {
  const isBotFlag = (value: any) => !!value && (value === true || typeof value === 'object');
  if (message?.webhook) return true;
  if (isBotFlag(message?.author?.bot)) return true;
  if (isBotFlag(author?.bot)) return true;
  if (isBotFlag(author?.user?.bot)) return true;
  if (isBotFlag(member?.user?.bot)) return true;
  if (isBotFlag(member?.bot)) return true;
  return false;
}

async function resolveMessageAuthor(message, client) {
  if (message?.author && !message.author.isWebhook) {
    // In server channels stoatbot.js may return ServerMember here, which is fine:
    // getAvatarUrl() knows how to fall through to member.user.
    return message.author;
  }

  const authorId = message?.authorId || message?.author;
  if (!authorId) return null;

  const cached = client?.users?.cache?.get?.(authorId);
  if (cached) return cached;

  // Do not fetch here: stoatbot.js logs noisy "Attempt 1 failed: object"
  // messages for failed REST lookups while generating transcripts. Cached data
  // is enough for avatar URLs, with default avatar fallback below.
  return null;
}

async function resolveMessageMember(message, client) {
  if (message?.member) return message.member;

  const authorId = message?.authorId || message?.author;
  const server = message?.server || client?.servers?.cache?.get?.(config.serverId);
  if (!authorId || !server) return null;

  const cached = server?.members?.cache?.get?.(authorId);
  if (cached) return cached;

  // Avoid REST fetch noise during transcript generation. If the member is not
  // cached, getMessageAvatarUrl() will use the cached user or default avatar.
  return null;
}

async function getMessageAvatarUrl(message, member, author, client) {
  if (message?.webhook?.avatar) {
    return buildAvatarUrl(message.webhook.avatar, client);
  }

  if (message?.masquerade?.avatar) {
    return typeof message.masquerade.avatar === 'string' && /^https?:\/\//i.test(message.masquerade.avatar)
      ? message.masquerade.avatar
      : buildAvatarUrl(message.masquerade.avatar, client);
  }

  return (
    await getAvatarUrl(member, client) ||
    await getAvatarUrl(author, client) ||
    buildDefaultAvatarUrl(message?.authorId || message?.author || author?.id, client) ||
    null
  );
}

async function getAvatarUrl(entity, client) {
  if (!entity) return null;

  if (typeof entity.avatarURL === 'string' && entity.avatarURL) {
    return entity.avatarURL;
  }

  if (typeof entity.avatarURL === 'function') {
    try {
      const url = entity.avatarURL();
      if (url) return url;
    } catch {
      // ignore
    }
  }

  if (typeof entity.displayAvatarURL === 'function') {
    try {
      const url = await entity.displayAvatarURL();
      if (url) return url;
    } catch {
      // ignore
    }
  }

  if (typeof entity.animatedAvatarURL === 'string' && entity.animatedAvatarURL) {
    return entity.animatedAvatarURL;
  }

  if (typeof entity.masqueradeAvatarURL === 'string' && entity.masqueradeAvatarURL) {
    return entity.masqueradeAvatarURL;
  }

  if (typeof entity.avatar === 'string' && /^https?:\/\//i.test(entity.avatar)) {
    return entity.avatar;
  }

  if (entity.avatar && typeof entity.avatar.createFileURL === 'function') {
    try {
      const url = entity.avatar.createFileURL(true) || entity.avatar.createFileURL();
      if (url) return url;
    } catch {
      // ignore
    }
  }

  const avatar = entity.avatar || entity.profile?.avatar || null;
  const directAvatar = buildAvatarUrl(avatar, client);
  if (directAvatar) return directAvatar;

  // ServerMember objects in stoatbot.js do not expose avatarURL(), and their
  // own avatar can be null while the underlying User has a profile avatar.
  if (entity.user && entity.user !== entity) {
    const userAvatar = await getAvatarUrl(entity.user, client);
    if (userAvatar) return userAvatar;
  }

  return buildDefaultAvatarUrl(entity.id, client);
}

function buildAvatarUrl(avatar, client) {
  const avatarId = extractFileId(avatar);
  if (!avatarId) return null;

  if (typeof avatar === 'string' && /^https?:\/\//i.test(avatar)) {
    return avatar;
  }

  const cdnBase = getCdnBase(client);
  return `${cdnBase}/avatars/${encodeURIComponent(avatarId)}`;
}

function buildDefaultAvatarUrl(userId, client) {
  if (!userId) return null;
  return `${getApiBase(client)}/users/${encodeURIComponent(String(userId))}/default_avatar`;
}

function getCdnBase(client) {
  return String(
    client?.options?.rest?.instanceCDNURL ||
    client?.configuration?.features?.autumn?.url ||
    'https://autumn.stoat.chat'
  ).replace(/\/$/, '');
}

function getApiBase(client) {
  return String(
    client?.options?.rest?.instanceURL ||
    client?.options?.baseURL ||
    'https://api.stoat.chat'
  ).replace(/\/$/, '');
}

function getAttachmentUrl(attachment) {
  if (!attachment) return null;

  const directCandidates = [
    attachment.originalUrl,
    attachment.original_url,
    typeof attachment.createFileURL === 'function' ? safeCreateFileUrl(attachment) : null,
    attachment.url,
    attachment.previewUrl,
    attachment.preview_url,
  ];

  for (const candidate of directCandidates) {
    const value = extractUrlString(candidate);
    if (value) return value;
  }

  const fileId = extractFileId(attachment) || extractFileId(attachment.file) || extractFileId(attachment.id) || extractFileId(attachment._id);
  const filename = String(attachment.filename || attachment.name || '').trim();

  if (fileId) {
    return buildAutumnAttachmentUrl(fileId, filename);
  }

  return null;
}

function getAttachmentFallbackUrls(attachment) {
  if (!attachment) return [];

  const filename = String(attachment.filename || attachment.name || '').trim();
  const fileId = extractFileId(attachment) || extractFileId(attachment.file) || extractFileId(attachment.id) || extractFileId(attachment._id);
  const urls = [];

  for (const candidate of [
    attachment.originalUrl,
    attachment.original_url,
    typeof attachment.createFileURL === 'function' ? safeCreateFileUrl(attachment) : null,
    attachment.url,
    attachment.previewUrl,
    attachment.preview_url,
  ]) {
    const value = extractUrlString(candidate);
    if (value && !urls.includes(value)) urls.push(value);
  }

  if (fileId) {
    for (const value of buildAutumnAttachmentUrlCandidates(fileId, filename)) {
      if (value && !urls.includes(value)) urls.push(value);
    }
  }

  return urls;
}

function buildAutumnAttachmentUrl(fileId, filename = '') {
  return buildAutumnAttachmentUrlCandidates(fileId, filename)[0];
}

function buildAutumnAttachmentUrlCandidates(fileId, filename = '') {
  const encodedFilename = filename
    ? `/${encodeURIComponent(filename).replace(/%20/g, '_')}`
    : '';

  const encodedId = encodeURIComponent(fileId);

  return [
    // Stoat/Revolt clients commonly expose files through the CDN host.
    `https://cdn.stoatusercontent.com/attachments/${encodedId}${encodedFilename}`,
    // Autumn fallback for instances that still proxy files through Autumn.
    `https://autumn.stoat.chat/attachments/${encodedId}${encodedFilename}`,
  ];
}

function safeCreateFileUrl(attachment) {
  try {
    return attachment.createFileURL();
  } catch {
    return null;
  }
}

function extractUrlString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value.url || value.originalUrl || value.original_url || value.href || null;
  }
  return null;
}

/**
 * Fetch all messages from a channel
 */
async function fetchAllMessages(channel) {
  const allMessages = [];
  let lastMessageId = null;
  const limit = 100;

  try {
    while (true) {
      const options: { limit: number; before?: string } = { limit };
      if (lastMessageId) {
        options.before = lastMessageId;
      }

      const result = await channel.messages.fetch(options as any);
      const messages = result instanceof Map ? Array.from(result.values()) : [];

      if (messages.length === 0) break;

      allMessages.push(...messages);
      lastMessageId = messages[messages.length - 1].id;

      if (allMessages.length >= 5000) {
        console.warn('Reached message limit of 5000');
        break;
      }

      if (messages.length < limit) break;
    }
  } catch (error) {
    console.error('Error fetching messages:', error);
  }

  return allMessages;
}

/**
 * Get human-readable content for system messages
 */
function getSystemMessageContent(systemMessage) {
  if (!systemMessage) return null;

  const type = systemMessage.type;

  switch (type) {
    case 'user_added':
      return `User was added to the channel`;
    case 'user_remove':
      return `User was removed from the channel`;
    case 'user_joined':
      return `User joined the server`;
    case 'user_left':
      return `User left the server`;
    case 'user_kicked':
      return `User was kicked`;
    case 'user_banned':
      return `User was banned`;
    case 'channel_renamed':
      return `Channel was renamed`;
    case 'channel_description_changed':
      return `Channel description was changed`;
    case 'channel_icon_changed':
      return `Channel icon was changed`;
    default:
      return `System event: ${type}`;
  }
}

function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function cleanupFile(filepath) {
  try {
    if (existsSync(filepath)) {
      unlinkSync(filepath);
    }
  } catch (error) {
    console.error('Error cleaning up temp file:', error);
  }
}