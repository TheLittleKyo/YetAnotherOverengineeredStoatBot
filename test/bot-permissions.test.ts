/**
 * Bot permissions: rule storage, the hierarchy fold, and the client-facing
 * resolver (owner bypass, role ranks, deny beating allow). Runs against a
 * throwaway data directory (YAOSB_DATA_DIR), set before the module is
 * imported so json-store picks up the temp path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-botperms-'));
const {
  BOT_PERMISSIONS,
  EVERYONE_TARGET,
  foldBotPermission,
  forgetMemberRoles,
  getBotPermissions,
  normalizeBotPermissionRule,
  removeBotPermissionRole,
  resolveBotPermission,
  runWithBotPermission,
  currentBotPermission,
  setBotPermissionRule,
} = await import('../src/bot-permissions.js');

const SERVER = 'srvBP';

/** Minimal stand-in for the stoatbot client shape the resolver reads. */
function fakeClient(serverId: string, options: {
  ownerId?: string;
  roles?: Record<string, { rank: number }>;
  memberRoles?: string[];
  serverOwner?: boolean;
} = {}) {
  const roles = new Map(Object.entries(options.roles || {}).map(([id, role]) => [id, { id, ...role }]));
  const member = {
    serverOwner: options.serverOwner === true,
    roles: (options.memberRoles || []).map((id) => roles.get(id) || { id }),
  };
  const members = new Map([['user-1', member]]);
  const server = {
    ownerId: options.ownerId || 'owner-1',
    roles: { cache: roles },
    // Both the REST fetch and the cache, like a real client: the resolver
    // fetches first and falls back to the cache.
    members: { cache: members, fetch: async (id: string) => members.get(id) || null },
  };
  const servers = new Map([[serverId, server]]);
  return { servers: { cache: servers, fetch: async (id: string) => servers.get(id) || null } };
}

function rule(allow: string[] = [], deny: string[] = []) {
  return { allow, deny };
}

/**
 * Member roles are memoized for a few seconds per (server, user), so a test
 * that swaps in a different fake client for the same member must drop them
 * first — production has one client, and role changes invalidate this.
 */
function swapClient(serverId: string) {
  forgetMemberRoles(serverId);
}

test('every catalog entry has a unique key, label, group and default', () => {
  const keys = new Set<string>();
  for (const def of BOT_PERMISSIONS) {
    assert.ok(def.key && !keys.has(def.key), `duplicate or missing key: ${def.key}`);
    keys.add(def.key);
    assert.ok(def.label, `${def.key} needs a label`);
    assert.ok(def.group, `${def.key} needs a group`);
    assert.ok(def.defaultAccess, `${def.key} needs a default description`);
    assert.ok(def.commands.length > 0, `${def.key} needs commands`);
  }
});

test('normalizeBotPermissionRule drops unknown keys, dedupes, and lets deny win', () => {
  const normalized = normalizeBotPermissionRule({
    allow: ['purge', 'purge', 'not-a-feature', 42, 'music'],
    deny: ['music', 'music'],
  });
  assert.deepEqual(normalized, { allow: ['purge'], deny: ['music'] });
});

test('rules round-trip per server and a role rule can be removed', () => {
  setBotPermissionRule(SERVER, 'role-a', rule(['purge']));
  setBotPermissionRule(SERVER, EVERYONE_TARGET, rule([], ['music']));

  const stored = getBotPermissions(SERVER);
  assert.deepEqual(stored.roles['role-a'], { allow: ['purge'], deny: [] });
  assert.deepEqual(stored.everyone, { allow: [], deny: ['music'] });
  assert.deepEqual(getBotPermissions('other-server').roles, {});

  removeBotPermissionRole(SERVER, 'role-a');
  assert.equal(getBotPermissions(SERVER).roles['role-a'], undefined);

  // An empty rule clears the entry rather than storing a blank one.
  setBotPermissionRule(SERVER, 'role-b', rule(['purge']));
  setBotPermissionRule(SERVER, 'role-b', rule());
  assert.equal(getBotPermissions(SERVER).roles['role-b'], undefined);
});

test('foldBotPermission: everyone first, then roles by rank, highest wins', () => {
  const rules = {
    serverId: SERVER,
    everyone: rule([], ['music']),
    roles: {
      member: rule([], ['music']),
      dj: rule(['music']),
      muted: rule([], ['music']),
    },
  };

  // No roles: the everyone rule applies.
  assert.equal(foldBotPermission(rules, 'music', []), 'deny');
  // A higher role (lower rank) overrides the everyone deny.
  assert.equal(foldBotPermission(rules, 'music', [{ id: 'member', rank: 10 }, { id: 'dj', rank: 2 }]), 'allow');
  // ...and a role above that one denies again.
  assert.equal(
    foldBotPermission(rules, 'music', [{ id: 'dj', rank: 2 }, { id: 'muted', rank: 1 }]),
    'deny',
  );
  // Equal ranks: deny wins.
  assert.equal(foldBotPermission(rules, 'music', [{ id: 'dj', rank: 5 }, { id: 'muted', rank: 5 }]), 'deny');
  // Unknown ranks sort lowest, so they lose to any ranked role.
  assert.equal(foldBotPermission(rules, 'music', [{ id: 'muted', rank: null }, { id: 'dj', rank: 9 }]), 'allow');
  // A feature nobody mentions is inherited.
  assert.equal(foldBotPermission(rules, 'purge', [{ id: 'dj', rank: 2 }]), null);
});

test('resolveBotPermission reads the member roles and never restricts the owner', async () => {
  const server = 'srvResolve';
  setBotPermissionRule(server, 'staff', rule(['purge']));
  setBotPermissionRule(server, EVERYONE_TARGET, rule([], ['purge']));

  const client = fakeClient(server, { roles: { staff: { rank: 3 } }, memberRoles: ['staff'] });
  assert.equal(await resolveBotPermission(client, server, 'user-1', 'purge'), 'allow');

  swapClient(server);
  const plain = fakeClient(server, { roles: { staff: { rank: 3 } }, memberRoles: [] });
  assert.equal(await resolveBotPermission(plain, server, 'user-1', 'purge'), 'deny');

  // Server owner and unknown features fall through to the built-in check.
  swapClient(server);
  assert.equal(await resolveBotPermission(client, server, 'owner-1', 'purge'), null);
  assert.equal(await resolveBotPermission(client, server, 'user-1', 'not-a-feature'), null);
  // So does a server with no rules at all.
  assert.equal(await resolveBotPermission(client, 'srvNoRules', 'user-1', 'purge'), null);
});

test('currentBotPermission only answers for the command author and feature', async () => {
  const server = 'srvContext';
  setBotPermissionRule(server, 'staff', rule(['purge']));
  const client = fakeClient(server, { roles: { staff: { rank: 3 } }, memberRoles: ['staff'] });

  assert.equal(await currentBotPermission(client, server, 'user-1'), null, 'no context outside a command');

  await runWithBotPermission('purge', 'user-1', async () => {
    assert.equal(await currentBotPermission(client, server, 'user-1'), 'allow');
    // A different member checked inside the same command is not covered.
    assert.equal(await currentBotPermission(client, server, 'user-2'), null);
  });

  // A different feature in the same command context resolves on its own key.
  await runWithBotPermission('music', 'user-1', async () => {
    assert.equal(await currentBotPermission(client, server, 'user-1'), null);
  });
});

test('permission helpers honor the command context, and ticket staff follows tickets.staff', async () => {
  const server = 'srvHelpers';
  const { hasPermissionInServer, isTicketStaff } = await import('../src/permissions.js');

  setBotPermissionRule(server, 'granted', rule(['backup']));
  setBotPermissionRule(server, 'blocked', rule([], ['backup']));
  setBotPermissionRule(server, 'staff', rule(['tickets.staff']));
  setBotPermissionRule(server, 'exstaff', rule([], ['tickets.staff']));

  /** A member with no Stoat permissions at all, holding `roleId`. */
  const client = (roleId: string, hasStoatPermission = false) =>
    Object.assign(fakeClient(server, { roles: { [roleId]: { rank: 4 } }, memberRoles: [roleId] }), {}) as any;
  const withStoatPermission = (base: any, allowed: boolean) => {
    const srv = base.servers.cache.get(server);
    const member = srv.members.cache.get('user-1');
    member.hasPermission = () => allowed;
    return base;
  };

  // Allow passes a Manage Server check the member would fail.
  const granted = withStoatPermission(client('granted'), false);
  assert.equal(await runWithBotPermission('backup', 'user-1', () =>
    hasPermissionInServer(granted, server, 'user-1', ['ManageServer'])), true);

  // Deny fails a check the member would pass.
  swapClient(server);
  const blocked = withStoatPermission(client('blocked'), true);
  assert.equal(await runWithBotPermission('backup', 'user-1', () =>
    hasPermissionInServer(blocked, server, 'user-1', ['ManageServer'])), false);

  // Outside that command context the Stoat permission decides again.
  assert.equal(await hasPermissionInServer(blocked, server, 'user-1', ['ManageServer']), true);

  // Ticket staff: allow counts as staff without the support role, deny drops it.
  const staffMember = { roleIds: ['support-role'] };
  swapClient(server);
  assert.equal(await isTicketStaff(client('staff'), server, 'user-1', { roleIds: [] }, 'support-role'), true);
  swapClient(server);
  assert.equal(await isTicketStaff(client('exstaff'), server, 'user-1', staffMember, 'support-role'), false);

  // No rule: the support role decides.
  swapClient(server);
  const plain = fakeClient(server, { roles: { other: { rank: 4 } }, memberRoles: ['other'] });
  assert.equal(await isTicketStaff(plain, server, 'user-1', staffMember, 'support-role'), true);
  assert.equal(await isTicketStaff(plain, server, 'user-1', { roleIds: [] }, 'support-role'), false);
});
