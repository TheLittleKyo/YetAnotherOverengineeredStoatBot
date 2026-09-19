/**
 * Direct messages to a single user.
 *
 * stoatbot.js loses the one thing a caller needs when a DM fails: the reason.
 * `user.sendDM` does not await its own `channel.send`, so it resolves before
 * delivery and turns a refused send into an unhandled rejection. `createDM`
 * reduces every API refusal to "status 403: Forbidden", and Stoat answers
 * `MissingPermission` both when the user has blocked the bot and when the two
 * share no server — failures that need different advice.
 *
 * `sendDirectMessage` opens the DM and awaits the send itself, and on failure
 * reads the bot's relationship with the user to say which case it was.
 */
import { stoatRequest } from './stoat-api.js';

export type DmFailure = 'blocked' | 'not-allowed' | 'unknown-user' | 'error';

/** `reason` and `detail` are set whenever `ok` is false. */
export type DmResult = { ok: boolean; reason?: DmFailure; detail?: string };

export type DmOptions = { content: string; attachments?: unknown[] };

/** Open (or reuse) the DM channel with `userId` and send `options` on it. */
export async function sendDirectMessage(client: any, userId: string, options: DmOptions): Promise<DmResult> {
  if (!userId) return { ok: false, reason: 'unknown-user', detail: 'No user id to DM.' };

  const user = client?.users?.cache?.get?.(userId) || (await client?.users?.fetch?.(userId).catch(() => null));
  if (!user || typeof user.createDM !== 'function') {
    return { ok: false, reason: 'unknown-user', detail: `User ${userId} could not be fetched.` };
  }

  try {
    const dm = await user.createDM();
    if (!dm || typeof dm.send !== 'function') throw new Error('The DM channel cannot send messages.');
    await dm.send(options);
    return { ok: true };
  } catch (error: any) {
    return diagnoseDmFailure(client, userId, error);
  }
}

/**
 * Work out why a DM was refused. The bot's relationship with the user is the
 * only field that separates "they blocked the bot" from "no shared server";
 * the error itself says neither.
 */
async function diagnoseDmFailure(client: any, userId: string, error: any): Promise<DmResult> {
  const detail = String(error?.message || error || 'unknown error');
  const relationship = await stoatRequest(client, 'GET', `/users/${encodeURIComponent(userId)}`)
    .then((user) => String(user?.relationship || ''))
    .catch(() => '');

  // `BlockedOther` is the user blocking the bot; the bot never blocks anyone.
  if (relationship === 'BlockedOther') {
    return { ok: false, reason: 'blocked', detail };
  }
  if (/\b403\b|MissingPermission|Forbidden/i.test(detail)) {
    return { ok: false, reason: 'not-allowed', detail };
  }
  return { ok: false, reason: 'error', detail };
}

/**
 * What the user should do about a failed DM, written to the person who was
 * meant to receive it.
 */
export function describeDmFailure(result: DmResult): string {
  if (result.ok) return '';
  switch (result.reason) {
    case 'blocked':
      return 'you have blocked me on Stoat. Unblock me from my profile, then try again';
    case 'not-allowed':
      return 'Stoat would not let me open a DM with you. Make sure you are still in a server with me, then try again';
    case 'unknown-user':
      return 'I could not look up your account';
    default:
      return 'the message could not be sent';
  }
}
