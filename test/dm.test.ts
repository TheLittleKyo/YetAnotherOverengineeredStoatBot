/**
 * Direct-message delivery. A DM the bot is not allowed to send has to come back
 * as a failure with the reason attached, because the commands that DM a
 * secret (the Cloudflare dashboard link, a captcha) tell the user what to fix.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendDirectMessage, describeDmFailure } from '../src/dm.js';

const USER_ID = '01ABCDEFGHJKMNPQRSTVWXYZ00';
const FORBIDDEN = new Error('API call failed with status 403: Forbidden');
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer the relationship lookup the way Stoat does for `GET /users/:id`. */
function stubRelationship(relationship: string) {
  globalThis.fetch = (async () => new Response(JSON.stringify({ _id: USER_ID, relationship }), { status: 200 })) as typeof fetch;
}

function fakeClient(user: any) {
  return {
    token: 'bot-token',
    bot: true,
    options: { rest: { instanceURL: 'http://stoat.invalid' } },
    users: {
      cache: new Map(user ? [[USER_ID, user]] : []),
      fetch: async () => {
        throw new Error('Unknown user');
      },
    },
  };
}

test('sendDirectMessage sends on the opened DM channel and awaits it', async () => {
  const sent: any[] = [];
  const user = {
    createDM: async () => ({
      send: async (options: any) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        sent.push(options);
      },
    }),
  };
  const result = await sendDirectMessage(fakeClient(user), USER_ID, { content: 'hello' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(sent, [{ content: 'hello' }]);
});

test('a refused send is reported as a failure, not delivered', async () => {
  stubRelationship('User');
  const user = { createDM: async () => ({ send: async () => Promise.reject(FORBIDDEN) }) };
  const result = await sendDirectMessage(fakeClient(user), USER_ID, { content: 'hello' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-allowed');
});

test('a user who blocked the bot is told to unblock it', async () => {
  stubRelationship('BlockedOther');
  const user = { createDM: async () => Promise.reject(FORBIDDEN) };
  const result = await sendDirectMessage(fakeClient(user), USER_ID, { content: 'hello' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked');
  assert.match(describeDmFailure(result), /unblock/i);
});

test('a refusal without a block is reported as not allowed', async () => {
  stubRelationship('None');
  const user = { createDM: async () => Promise.reject(FORBIDDEN) };
  const result = await sendDirectMessage(fakeClient(user), USER_ID, { content: 'hello' });
  assert.equal(result.reason, 'not-allowed');
  assert.match(describeDmFailure(result), /server/i);
});

test('an unknown user fails before any DM is attempted', async () => {
  const result = await sendDirectMessage(fakeClient(null), USER_ID, { content: 'hello' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-user');
});
