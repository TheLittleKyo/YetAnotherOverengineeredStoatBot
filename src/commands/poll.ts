import { config } from '../config.js';
import { hasPermission } from '../permissions.js';
import { formatDuration, parseDuration } from '../duration.js';
import { closePoll, countVotes, createPoll, deletePoll, getPoll, listPolls, MAX_OPTIONS } from '../polls.js';

/**
 * `poll` — reaction-counted votes.
 *
 *   poll "Question" "Option A" "Option B" [--time 2h] [--multi] [--anon]
 *   poll "Question"                       yes/no poll
 *   poll list
 *   poll end <id>
 *   poll delete <id>
 *
 * Quotes matter: the question and each option are quoted strings, so an option
 * can contain spaces. Unquoted text after the question is taken as one option
 * per comma, which is the shorthand people reach for first.
 */

export async function pollCommand(message: any, args: string[], client: any) {
  const raw = args.join(' ').trim();
  const sub = (args[0] || '').toLowerCase();

  if (!raw || sub === 'help') {
    await sendHelp(message);
    return;
  }

  const serverId = String(message?.channel?.serverId || message?.serverId || config.serverId || '');
  if (!serverId) {
    await message.channel?.send({ content: '❌ Polls only work inside a server.' });
    return;
  }

  if (sub === 'list') {
    await message.channel?.send({ content: renderList(serverId) });
    return;
  }

  if (sub === 'end' || sub === 'close') {
    if (!(await requireManage(message, client))) return;
    const id = String(args[1] || '');
    // Poll ids are global; one server's moderators must not close another's.
    if (getPoll(id)?.serverId !== serverId) {
      await message.channel?.send({ content: `❌ No poll \`${id}\` in this server.` });
      return;
    }
    const result = await closePoll(client, id, String(message?.authorId || ''));
    await message.channel?.send({ content: result.ok ? `✅ Poll closed. Results posted.` : `❌ ${result.error}` });
    return;
  }

  if (sub === 'delete' || sub === 'remove') {
    if (!(await requireManage(message, client))) return;
    const id = String(args[1] || '');
    const poll = getPoll(id);
    const removed = poll?.serverId === serverId && deletePoll(id);
    await message.channel?.send({
      content: removed ? `🗑️ Poll "${poll?.question || id}" deleted. The message is left in place.` : `❌ No poll \`${id}\`.`,
    });
    return;
  }

  if (!(await requireManage(message, client))) return;

  const parsed = parsePollArgs(raw);
  if ('error' in parsed) {
    await message.channel?.send({ content: `❌ ${parsed.error}` });
    return;
  }

  const result = await createPoll(client, {
    serverId,
    channelId: String(message?.channelId || message?.channel?.id || ''),
    question: parsed.question,
    options: parsed.options,
    multi: parsed.multi,
    anonymous: parsed.anonymous,
    durationMs: parsed.durationMs,
    createdBy: String(message?.authorId || ''),
    createdByName: String(message?.member?.nickname || message?.author?.username || ''),
  });

  if (!result.ok) {
    await message.channel?.send({ content: `❌ ${result.error}` });
    return;
  }

  const closing = parsed.durationMs ? ` It closes in ${formatDuration(parsed.durationMs)}.` : ` End it with \`${config.prefix}poll end ${result.poll.id}\`.`;
  await message.channel?.send({ content: `📊 Poll \`${result.poll.id}\` posted.${closing}` });
}

async function requireManage(message: any, client: any): Promise<boolean> {
  const allowed = await hasPermission(message, client, ['ManageMessages', 'ManageServer']);
  if (!allowed) {
    await message.channel?.send({ content: '❌ You need Manage Messages permission to run polls.' });
  }
  return allowed;
}

type ParsedPoll = { question: string; options: string[]; multi: boolean; anonymous: boolean; durationMs: number | null };

/** Split a poll command line into its question, options and flags. */
export function parsePollArgs(input: string): ParsedPoll | { error: string } {
  // Phones type curly quotes; they delimit fields exactly like straight ones.
  let text = String(input || '').replace(/[“”„‟″]/g, '"').trim();

  const multi = /(^|\s)--multi(\s|$)/i.test(text);
  const anonymous = /(^|\s)--anon(ymous)?(\s|$)/i.test(text);

  let durationMs: number | null = null;
  const timeMatch = text.match(/(?:^|\s)--(?:time|duration)\s+(\S+)/i);
  if (timeMatch) {
    const parsed = parseDuration(timeMatch[1]);
    if (parsed === undefined) return { error: `\`${timeMatch[1]}\` is not a duration. Try \`2h\` or \`30m\`.` };
    durationMs = parsed;
  }

  text = text
    .replace(/(?:^|\s)--(?:time|duration)\s+\S+/gi, ' ')
    .replace(/(?:^|\s)--multi(?=\s|$)/gi, ' ')
    .replace(/(?:^|\s)--anon(?:ymous)?(?=\s|$)/gi, ' ')
    .trim();

  // Quoted form: every "…" is one field, question first.
  const quoted = Array.from(text.matchAll(/"([^"]+)"/g)).map((match) => match[1].trim()).filter(Boolean);
  if (quoted.length) {
    const [question, ...options] = quoted;
    if (options.length > MAX_OPTIONS) return { error: `A poll can have at most ${MAX_OPTIONS} options.` };
    return { question, options, multi, anonymous, durationMs };
  }

  // Shorthand: `question? a, b, c` — the question runs to the first `?` or `|`.
  const split = text.match(/^(.*?[?|])\s*(.*)$/s);
  if (split && split[2].trim()) {
    const question = split[1].replace(/\|$/, '').trim();
    const options = split[2].split(',').map((option) => option.trim()).filter(Boolean);
    if (options.length > MAX_OPTIONS) return { error: `A poll can have at most ${MAX_OPTIONS} options.` };
    return { question, options, multi, anonymous, durationMs };
  }

  if (!text) return { error: 'Give the poll a question.' };
  return { question: text, options: [], multi, anonymous, durationMs };
}

function renderList(serverId: string): string {
  const polls = listPolls(serverId).slice(0, 10);
  if (!polls.length) return `No polls yet. Start one with \`${config.prefix}poll "Question" "A" "B"\`.`;

  const lines = polls.map((poll) => {
    const { total } = countVotes(poll);
    const state = poll.closed
      ? 'closed'
      : poll.endsAt
        ? `closes in ${formatDuration(poll.endsAt - Date.now())}`
        : 'open';
    return `- \`${poll.id}\` **${poll.question.slice(0, 70)}** · ${total} vote(s) · ${state}`;
  });
  return `## 📊 Polls\n${lines.join('\n')}`;
}

async function sendHelp(message: any) {
  const p = config.prefix;
  await message.channel?.send({
    content: [
      '## 📊 Polls',
      `\`${p}poll "Favourite colour?" "Red" "Blue" "Green"\``,
      `\`${p}poll "Ship it?"\` — a yes/no poll`,
      `\`${p}poll Ship it? yes, no, later\` — shorthand, options split on commas`,
      `\`--time 2h\` closes it automatically · \`--multi\` allows several votes · \`--anon\` hides who voted`,
      `\`${p}poll list\` · \`${p}poll end <id>\` · \`${p}poll delete <id>\``,
      '',
      `Up to ${MAX_OPTIONS} options. Votes are reactions; removing your reaction withdraws the vote.`,
    ].join('\n'),
  });
}
