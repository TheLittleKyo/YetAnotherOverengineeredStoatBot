/** Reliable direct-message delivery for stoatbot.js. */

/**
 * Resolve a user-owned DMChannel and send through the channel's documented
 * `send()` method. stoatbot.js's User.sendDM() does not await that send, so it
 * can report success before the message has actually been delivered.
 */
export async function sendDirectMessage(client: any, userId: string, options: any): Promise<boolean> {
  if (!client || !userId) return false;

  let lastError: unknown = null;

  const user = await resolveUser(client, userId);
  if (user && typeof user.createDM === 'function') {
    try {
      const dmChannel = await user.createDM();
      if (dmChannel && typeof dmChannel.send === 'function') {
        await dmChannel.send(options);
        return true;
      }
    } catch (error) {
      lastError = error;
    }
  }

  // Recovery path for stale/missing user objects or a failed SDK lookup.
  // The API returns the same direct-channel shape that stoatbot.js turns into
  // a DMChannel, and the fetched channel still sends via DMChannel.send().
  try {
    if (typeof client.api?.post !== 'function') throw new Error('DM API is unavailable.');

    const rawChannel = await client.api.post('/users/@me/dms', { recipient: userId });
    const channelId = rawChannel?._id || rawChannel?.id;
    if (!channelId) throw new Error('DM API returned no channel id.');

    let dmChannel = client.channels?.cache?.get?.(channelId) || null;
    if (!dmChannel && typeof client.channels?.fetch === 'function') {
      dmChannel = await client.channels.fetch(channelId);
    }
    if (!dmChannel && typeof client.channels?._add === 'function') {
      dmChannel = client.channels._add(rawChannel);
    }
    if (!dmChannel || typeof dmChannel.send !== 'function') {
      throw new Error('The created DM channel could not be resolved.');
    }

    await dmChannel.send(options);
    return true;
  } catch (error) {
    lastError = error;
  }

  if (lastError) {
    console.warn(`[dm] Message to ${userId} failed: ${(lastError as any)?.message || lastError}`);
  }
  return false;
}

async function resolveUser(client: any, userId: string): Promise<any> {
  const cached = client.users?.cache?.get?.(userId);
  if (cached) return cached;

  if (typeof client.users?.fetch === 'function') {
    try {
      return await client.users.fetch(userId);
    } catch {
      // The API channel fallback below can still work without a User object.
    }
  }

  return null;
}