import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiAlertTriangle, FiCheck, FiCopy, FiEdit3, FiPlus, FiRefreshCw, FiRotateCcw, FiSave, FiTrash2, FiUsers } from 'react-icons/fi';
import { API_BASE, getJson, patchJson, postJson, putJson } from '../shared/api.js';
import { confirmDialog, useUnsavedChanges } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;

type PermissionInfo = { key: string; label: string; bit: number };
type PermissionOverride = { allow: number; deny: number };
type RoleSummary = { id: string; name: string; color: string; hoist: boolean; rank: number | null; permissions: PermissionOverride };
type BotFeature = { key: string; label: string; group: string; commands: string[]; defaultAccess: string; sensitive?: boolean };
type BotRule = { allow: string[]; deny: string[] };
type BotRules = { everyone: BotRule; roles: Record<string, BotRule> };
type BotState = 'allow' | 'deny' | 'inherit';
type EditorTab = 'role' | 'bot';

const DEFAULT_BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';
const EMPTY_PERMISSIONS: PermissionOverride = { allow: 0, deny: 0 };
const DEFAULT_ROLE_COLOR = '#64748B';
const EVERYONE = 'everyone';
const EMPTY_BOT_RULE: BotRule = { allow: [], deny: [] };

function App() {
  const [botName, setBotName] = useState(DEFAULT_BOT_NAME);
  const [prefix, setPrefix] = useState('!');
  const [permissionDefs, setPermissionDefs] = useState<PermissionInfo[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [roleId, setRoleId] = useState('');
  const [roleQuery, setRoleQuery] = useState('');
  const [roleName, setRoleName] = useState('New role');
  const [hoist, setHoist] = useState(false);
  const [permissions, setPermissions] = useState<PermissionOverride>(EMPTY_PERMISSIONS);
  const [angle, setAngle] = useState(90);
  const [colors, setColors] = useState(['#ff4d8d', '#7c3aed', '#00d4ff']);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedPermissions, setCopiedPermissions] = useState<PermissionOverride | null>(null);
  const [tab, setTab] = useState<EditorTab>('role');
  const [everyoneSelected, setEveryoneSelected] = useState(false);
  const [botFeatures, setBotFeatures] = useState<BotFeature[]>([]);
  const [botRules, setBotRules] = useState<BotRules>({ everyone: EMPTY_BOT_RULE, roles: {} });
  // Unsaved edits, tagged with the target they belong to. Anything else falls
  // back to the saved rule, so a rule that arrives (or is switched to) after an
  // edit can never be mistaken for the draft.
  const [draft, setDraft] = useState<{ target: string; rule: BotRule } | null>(null);
  const [featureQuery, setFeatureQuery] = useState('');

  useEffect(() => {
    Promise.all([loadConfig(), refreshRoles(), loadBotPermissions()])
      .then(([config, , bot]) => {
        setBotName(normalizeText(config.botName, DEFAULT_BOT_NAME));
        setPrefix(normalizeText(config.prefix, '!'));
        setPermissionDefs(Array.isArray(config.permissions) ? config.permissions : []);
        setAngle(Number(config.defaults?.angle) || 90);
        setColors(normalizeColors(config.defaults?.colors || colors));
        setBotFeatures(Array.isArray(bot.features) ? bot.features : []);
        setBotRules(normalizeBotRules(bot.rules));
      })
      .catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(''), 4500);
    return () => clearTimeout(timer);
  }, [status]);

  const selectedRole = useMemo(() => roles.find((role) => role.id === roleId) || null, [roles, roleId]);
  const roleColor = useMemo(
    () => colors.length <= 1 ? (colors[0] || DEFAULT_ROLE_COLOR) : `linear-gradient(${clampAngle(angle)}deg, ${colors.join(', ')})`,
    [angle, colors]
  );
  const roleColorIsGradient = roleColor.startsWith('linear-gradient(');
  const filteredRoles = useMemo(() => {
    const query = roleQuery.trim().toLowerCase();
    const ordered = roles.slice().sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999) || a.name.localeCompare(b.name));
    if (!query) return ordered;
    return ordered.filter((role) => role.id.toLowerCase().includes(query) || role.name.toLowerCase().includes(query));
  }, [roles, roleQuery]);
  const everyoneMatchesQuery = !roleQuery.trim() || 'everyone'.includes(roleQuery.trim().toLowerCase());

  // The bot-permission rule being edited: the Everyone rule or the selected role's.
  const botTarget = everyoneSelected ? EVERYONE : roleId;
  const savedBotRule = everyoneSelected ? botRules.everyone : (botRules.roles[roleId] || EMPTY_BOT_RULE);
  const botDraft = draft && draft.target === botTarget ? draft.rule : savedBotRule;
  const botDirty = !!botTarget && !sameBotRule(botDraft, savedBotRule);
  useUnsavedChanges(botDirty);
  const activeTab: EditorTab = everyoneSelected ? 'bot' : tab;
  const filteredFeatures = useMemo(() => {
    const query = featureQuery.trim().toLowerCase();
    if (!query) return botFeatures;
    return botFeatures.filter((feature) =>
      [feature.label, feature.group, feature.key, ...feature.commands].some((text) => text.toLowerCase().includes(query))
    );
  }, [botFeatures, featureQuery]);

  async function refreshRoles() {
    const nextRoles = await loadRoles();
    setRoles(nextRoles);
    return nextRoles;
  }

  async function refreshAll() {
    if (!(await confirmDiscardBotDraft())) return;
    await runBusy(async () => {
      const [, bot] = await Promise.all([refreshRoles(), loadBotPermissions()]);
      setBotRules(normalizeBotRules(bot.rules));
      setDraft(null);
    });
  }

  /** Ask before a navigation throws away unsaved bot-permission edits. */
  async function confirmDiscardBotDraft() {
    return !botDirty || confirmDialog({ title: 'Discard unsaved bot permission changes?', confirmLabel: 'Discard', danger: true });
  }

  async function selectEveryone() {
    if (!(await confirmDiscardBotDraft())) return;
    setEveryoneSelected(true);
    setRoleId('');
    setDraft(null);
    // Everyone has no role settings, so the bot tab stays selected when the
    // operator moves on to a real role.
    setTab('bot');
    setStatus('Editing bot permissions for everyone.');
  }

  async function selectRole(role: RoleSummary) {
    if (!(await confirmDiscardBotDraft())) return;
    setEveryoneSelected(false);
    setDraft(null);
    setRoleId(role.id);
    setRoleName(role.name);
    setHoist(Boolean(role.hoist));
    setPermissions(role.permissions || EMPTY_PERMISSIONS);
    const parsed = parseGradient(role.color);
    if (parsed) {
      setAngle(parsed.angle);
      setColors(parsed.colors);
    } else if (/^#[0-9a-f]{6}$/i.test(role.color || '')) {
      setColors([role.color]);
    } else {
      setColors([DEFAULT_ROLE_COLOR]);
    }
    setStatus(`Editing ${role.name}.`);
  }

  function newDraft() {
    setEveryoneSelected(false);
    setTab('role');
    setDraft(null);
    setRoleId('');
    setRoleName('New role');
    setHoist(false);
    setPermissions(EMPTY_PERMISSIONS);
    setStatus('New role draft created.');
  }

  function setBotPermission(key: string, state: BotState) {
    if (!botTarget) return;
    setDraft({
      target: botTarget,
      rule: {
        allow: state === 'allow' ? addKey(botDraft.allow, key) : botDraft.allow.filter((item) => item !== key),
        deny: state === 'deny' ? addKey(botDraft.deny, key) : botDraft.deny.filter((item) => item !== key),
      },
    });
  }

  async function saveBotPermissions() {
    if (!botTarget) return setStatus('Choose a role first.');
    await runBusy(async () => {
      const result = await putJson(`/api/bot-permissions/${encodeURIComponent(botTarget)}`, botDraft);
      setBotRules(normalizeBotRules(result.rules));
      setDraft(null);
      setStatus('Bot permissions saved.');
    });
  }

  function updateColor(index: number, value: string) {
    setColors((current) => current.map((color, colorIndex) => colorIndex === index ? normalizeColor(value, color) : color));
  }

  function addColor() {
    setColors((current) => current.length >= 8 ? current : current.concat('#ffffff'));
  }

  function removeColor(index: number) {
    setColors((current) => current.length <= 1 ? current : current.filter((_, colorIndex) => colorIndex !== index));
  }

  function setPermission(bit: number, state: 'allow' | 'deny' | 'inherit') {
    setPermissions((current) => {
      let allow = removeBit(current.allow, bit);
      let deny = removeBit(current.deny, bit);
      if (state === 'allow') allow = addBit(allow, bit);
      if (state === 'deny') deny = addBit(deny, bit);
      return { allow, deny };
    });
  }

  async function saveCurrentRole() {
    await runBusy(async () => {
      const result = roleId
        ? await updateRole(roleId, { name: roleName, gradient: roleColor, hoist, permissions })
        : await createRole({ name: roleName, gradient: roleColor, hoist, permissions });
      applyRolesResult(result);
      if (!roleId) setRoleId(result.roleId || '');
      setStatus(roleId ? 'Saved.' : 'Role created.');
    });
  }

  async function duplicateCurrentRole() {
    if (!roleId) return setStatus('Choose a role to duplicate first.');
    await runBusy(async () => {
      const result = await duplicateRole(roleId, `${roleName || selectedRole?.name || 'Role'} copy`);
      applyRolesResult(result);
      setRoleId(result.roleId || '');
      const next = result.roles?.find?.((role: RoleSummary) => role.id === result.roleId);
      if (next) await selectRole(next);
      setStatus('Role duplicated.');
    });
  }

  function copyPermissions() {
    setCopiedPermissions({ allow: permissions.allow || 0, deny: permissions.deny || 0 });
    setStatus('Permissions copied.');
  }

  function pastePermissions() {
    if (!copiedPermissions) return setStatus('Copy permissions from a role first.');
    setPermissions({ ...copiedPermissions });
    setStatus('Permissions pasted. Click Save to apply.');
  }

  async function deleteCurrentRole() {
    if (!roleId) return setStatus('Choose a role to delete first.');
    if (!(await confirmDialog({ title: `Delete role "${roleName || selectedRole?.name || roleId}"?`, message: 'Members lose the role. This cannot be undone.', confirmLabel: 'Delete role', danger: true }))) return;
    await runBusy(async () => {
      const deletedId = roleId;
      const result = await deleteRole(deletedId);
      applyRolesResult(result);
      // The server drops a deleted role's bot permissions; mirror that locally.
      setBotRules((current) => {
        const nextRoles = { ...current.roles };
        delete nextRoles[deletedId];
        return { ...current, roles: nextRoles };
      });
      newDraft();
      setStatus(`Role ${deletedId} deleted.`);
    });
  }

  async function runBusy(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error: any) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  }

  function applyRolesResult(result: any) {
    if (Array.isArray(result?.roles)) setRoles(result.roles);
  }

  const selectedLabel = everyoneSelected ? 'Everyone' : (selectedRole?.name || roleName || 'this role');
  const allowedFeatures = botFeatures.filter((feature) => botDraft.allow.includes(feature.key));
  const deniedFeatures = botFeatures.filter((feature) => botDraft.deny.includes(feature.key));

  return h('div', { className: 'app' },
    h('header', { className: 'hero' },
      h('div', null,
        h('div', { className: 'eyebrow' }, botName),
        h('h1', null, 'Roles'),
        h('p', null, 'Edit server roles and what each role can do with the bot.'),
      ),
      h('div', { className: 'hero-actions' },
        h('button', { className: 'secondary', onClick: async () => { if (await confirmDiscardBotDraft()) newDraft(); } }, h(FiEdit3), 'New draft'),
        h('button', { className: 'secondary', disabled: busy, onClick: refreshAll }, h(FiRefreshCw), 'Refresh'),
      ),
    ),

    h('main', { className: 'workspace' },
      h('section', { className: 'panel role-panel' },
        h('div', { className: 'panel-head compact' }, h('div', null, h('h2', null, 'Roles'), h('p', null, `${roles.length} cached roles`))),
        h(Field, { label: 'Search roles', value: roleQuery, onChange: setRoleQuery, placeholder: 'Role name or ID' }),
        h('div', { className: 'role-list' },
          everyoneMatchesQuery && h('button', {
            key: EVERYONE,
            className: `role-row ${everyoneSelected ? 'selected' : ''}`,
            onClick: selectEveryone,
          },
            h('span', { className: 'role-swatch everyone-swatch' }, h(FiUsers)),
            h('span', null, h('strong', null, 'Everyone'), h('small', null, 'Bot permissions for all members')),
            everyoneSelected && h(FiCheck),
          ),
          filteredRoles.length
            ? filteredRoles.map((role) => h('button', {
                key: role.id,
                className: `role-row ${role.id === roleId ? 'selected' : ''}`,
                onClick: () => selectRole(role),
              },
                h('span', { className: 'role-swatch', style: { background: role.color || '#64748b' } }),
                h('span', null, h('strong', null, role.name), h('small', null, role.id)),
                role.id === roleId && h(FiCheck),
              ))
            : h('div', { className: 'empty compact' }, 'No roles found. Paste an ID or create a new role.'),
        ),
      ),

      h('section', { className: 'panel editor-panel scroll-panel' },
        h('div', { className: 'editor-tabs', role: 'tablist', 'aria-label': 'Role editor sections' },
          h('button', {
            role: 'tab',
            'aria-selected': activeTab === 'role',
            className: activeTab === 'role' ? 'is-active' : '',
            disabled: everyoneSelected,
            title: everyoneSelected ? 'Everyone is not a Stoat role, so only bot permissions apply.' : undefined,
            onClick: () => setTab('role'),
          }, 'Role settings'),
          h('button', {
            role: 'tab',
            'aria-selected': activeTab === 'bot',
            className: activeTab === 'bot' ? 'is-active' : '',
            disabled: !botTarget,
            title: botTarget ? undefined : 'Create the role first.',
            onClick: () => setTab('bot'),
          }, 'Bot permissions', botDirty && h('span', { className: 'tab-dot', title: 'Unsaved changes' })),
        ),

        activeTab === 'role' && h(React.Fragment, null,
          h('div', { className: 'panel-head compact' }, h('div', null, h('h2', null, roleId ? 'Edit role' : 'Create role'), h('p', null, 'Name, color, display, permissions.'))),
          h(Field, { label: 'Role name', value: roleName, onChange: setRoleName, placeholder: 'Role name' }),
          h('label', { className: 'toggle-row' },
            h('input', { type: 'checkbox', checked: hoist, onChange: (event: any) => setHoist(event.target.checked) }),
            h('span', null, 'Display role separately / hoist'),
          ),
          h('div', { className: 'grid2' },
            h(Field, { label: 'Angle', value: String(angle), type: 'number', onChange: (value: string) => setAngle(clampAngle(Number(value))) }),
            h('label', { className: 'field' }, h('span', null, roleColorIsGradient ? 'Gradient CSS' : 'Color CSS'), h('input', { value: roleColor, readOnly: true, onFocus: (event: any) => event.target.select() })),
          ),
          h('div', { className: 'color-stack' },
            colors.map((color, index) => h('div', { className: 'color-stop', key: `${index}-${color}` },
              h('input', { type: 'color', value: toHex(color, '#ffffff'), onChange: (event: any) => updateColor(index, event.target.value) }),
              h('input', { value: color, onChange: (event: any) => updateColor(index, event.target.value), placeholder: '#00bcd4' }),
              h('button', { className: 'icon danger', disabled: colors.length <= 1, onClick: () => removeColor(index), title: 'Remove stop' }, h(FiTrash2)),
            )),
            h('button', { className: 'secondary add-stop', disabled: colors.length >= 8, onClick: addColor }, h(FiPlus), 'Add color stop'),
          ),
          h('div', { className: 'action-grid' },
            h('button', { className: 'primary', disabled: busy, onClick: saveCurrentRole }, h(FiSave), roleId ? 'Save' : 'Create'),
            h('button', { className: 'secondary', disabled: busy || !roleId, onClick: duplicateCurrentRole }, h(FiCopy), 'Duplicate'),
            h('button', { className: 'danger', disabled: busy || !roleId, onClick: deleteCurrentRole }, h(FiTrash2), 'Delete'),
          ),
          h('div', { className: 'permission-editor' },
            h('div', { className: 'panel-head compact' },
              h('div', null, h('h2', null, 'Permissions'), h('p', null, 'Set each permission to inherit, allow, or deny for this role.')),
              h('div', { className: 'permission-tools' },
                h('button', { className: 'secondary', disabled: busy, onClick: copyPermissions }, 'Copy'),
                h('button', { className: 'secondary', disabled: busy || !copiedPermissions, onClick: pastePermissions }, 'Paste'),
              ),
            ),
            permissionDefs.map((perm) => h(PermissionRow, { key: perm.key, perm, state: getPermissionState(permissions, perm.bit), setPermission })),
          ),
        ),

        activeTab === 'bot' && h(React.Fragment, null,
          h('div', { className: 'panel-head compact' },
            h('div', null,
              h('h2', null, `Bot permissions: ${selectedLabel}`),
              h('p', null, everyoneSelected
                ? 'Applies to every member, before their roles.'
                : 'Allow grants the whole feature, including its management actions. Deny blocks it.'),
            ),
            h('div', { className: 'permission-tools' },
              h('button', {
                className: 'secondary',
                disabled: busy || (botDraft.allow.length === 0 && botDraft.deny.length === 0),
                onClick: () => setDraft({ target: botTarget, rule: EMPTY_BOT_RULE }),
                title: 'Set every feature back to Inherit',
              }, h(FiRotateCcw), 'Reset'),
              h('button', { className: 'primary', disabled: busy || !botDirty, onClick: saveBotPermissions }, h(FiSave), 'Save'),
            ),
          ),
          h(Field, { label: 'Filter features', value: featureQuery, onChange: setFeatureQuery, placeholder: 'Feature or command' }),
          h('div', { className: 'bot-perm-list' },
            filteredFeatures.length
              ? groupFeatures(filteredFeatures).map(([group, features]) => h('div', { className: 'bot-perm-group', key: group },
                  h('div', { className: 'bot-perm-group-title' }, group),
                  features.map((feature) => h(BotPermissionRow, {
                    key: feature.key,
                    feature,
                    prefix,
                    state: getBotState(botDraft, feature.key),
                    onChange: setBotPermission,
                  })),
                ))
              : h('div', { className: 'empty compact' }, 'No features match that filter.'),
          ),
        ),
      ),

      activeTab === 'role'
        ? h('section', { className: 'panel preview-panel' },
            h('div', { className: 'panel-head compact' }, h('div', null, h('h2', null, 'Preview'), h('p', null, selectedRole ? `Previewing ${selectedRole.name}` : 'Draft role preview'))),
            h('div', { className: 'preview-card' },
              h('div', { className: 'role-badge' },
                h('span', {
                  className: roleColorIsGradient ? 'role-gradient-text' : 'role-color-text',
                  style: roleColorIsGradient ? { backgroundImage: roleColor } : { color: roleColor },
                }, roleName || selectedRole?.name || roleId || 'Role name'),
              ),
              h('div', { className: 'gradient-strip', style: { background: roleColor } }),
              h('code', null, roleColor),
            ),
            h('div', { className: 'permission-summary' },
              h('strong', null, 'Permission bitfields'),
              h('code', null, `allow: ${permissions.allow}\ndeny: ${permissions.deny}`),
            ),
          )
        : h('section', { className: 'panel preview-panel' },
            h('div', { className: 'panel-head compact' }, h('div', null, h('h2', null, 'Summary'), h('p', null, botDirty ? 'Unsaved changes' : 'All changes saved'))),
            h(FeatureSummary, { title: 'Allowed', tone: 'allow', features: allowedFeatures, empty: 'Nothing beyond the defaults.' }),
            h(FeatureSummary, { title: 'Denied', tone: 'deny', features: deniedFeatures, empty: 'Nothing denied.' }),
            h('div', { className: 'permission-summary rules-note' },
              h('strong', null, 'How rules combine'),
              h('p', null, 'Everyone applies first, then each role from the bottom of the role list to the top. The highest role set to Allow or Deny wins.'),
              h('p', null, 'Inherit keeps the default shown under each feature. The server owner is never restricted, and rules only affect this server.'),
            ),
          ),
    ),
    h('div', { className: `status ${status ? 'show' : ''}` }, status),
  );
}

function Field({ label, value, onChange, type = 'text', placeholder = '' }: any) {
  return h('label', { className: 'field' },
    h('span', null, label),
    h('input', { value, type, placeholder, onChange: (event: any) => onChange(event.target.value) }),
  );
}

function PermissionRow({ perm, state, setPermission }: { perm: PermissionInfo; state: string; setPermission: (bit: number, state: any) => void }) {
  return h('div', { className: 'permission-row' },
    h('span', null, perm.label),
    h('div', { className: 'permission-buttons' },
      h('button', { className: state === 'inherit' ? 'selected' : '', onClick: () => setPermission(perm.bit, 'inherit') }, 'Inherit'),
      h('button', { className: state === 'allow' ? 'selected allow' : 'allow', onClick: () => setPermission(perm.bit, 'allow') }, 'Allow'),
      h('button', { className: state === 'deny' ? 'selected deny' : 'deny', onClick: () => setPermission(perm.bit, 'deny') }, 'Deny'),
    ),
  );
}

function BotPermissionRow({ feature, prefix, state, onChange }: {
  feature: BotFeature;
  prefix: string;
  state: BotState;
  onChange: (key: string, state: BotState) => void;
}) {
  return h('div', { className: `bot-perm-row ${state}` },
    h('div', { className: 'bot-perm-text' },
      h('span', { className: 'bot-perm-label' },
        feature.label,
        feature.sensitive && h('span', { className: 'bot-perm-tag', title: 'Allowing this hands out moderation or server-wide power.' }, h(FiAlertTriangle), 'High impact'),
      ),
      h('span', { className: 'bot-perm-commands' }, feature.commands.map((command) => `${prefix}${command}`).join('  ·  ')),
      h('span', { className: 'bot-perm-default' }, `Default: ${feature.defaultAccess}`),
    ),
    h('div', { className: 'permission-buttons', role: 'radiogroup', 'aria-label': feature.label },
      (['inherit', 'allow', 'deny'] as BotState[]).map((option) => h('button', {
        key: option,
        role: 'radio',
        'aria-checked': state === option,
        className: `${option === 'inherit' ? '' : option} ${state === option ? 'selected' : ''}`.trim(),
        onClick: () => onChange(feature.key, option),
      }, option === 'inherit' ? 'Inherit' : option === 'allow' ? 'Allow' : 'Deny')),
    ),
  );
}

function FeatureSummary({ title, tone, features, empty }: { title: string; tone: 'allow' | 'deny'; features: BotFeature[]; empty: string }) {
  return h('div', { className: 'permission-summary' },
    h('strong', null, `${title} (${features.length})`),
    features.length
      ? h('div', { className: 'feature-chips' }, features.map((feature) => h('span', { key: feature.key, className: `feature-chip ${tone}` }, feature.label)))
      : h('p', null, empty),
  );
}

function groupFeatures(features: BotFeature[]): Array<[string, BotFeature[]]> {
  const groups = new Map<string, BotFeature[]>();
  for (const feature of features) groups.set(feature.group, (groups.get(feature.group) || []).concat(feature));
  return Array.from(groups.entries());
}

function getBotState(rule: BotRule, key: string): BotState {
  if (rule.deny.includes(key)) return 'deny';
  if (rule.allow.includes(key)) return 'allow';
  return 'inherit';
}

function addKey(list: string[], key: string) {
  return list.includes(key) ? list : list.concat(key);
}

function sameBotRule(a: BotRule, b: BotRule) {
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((key) => y.includes(key));
  return same(a.allow, b.allow) && same(a.deny, b.deny);
}

function normalizeBotRule(value: any): BotRule {
  const keys = (list: any) => (Array.isArray(list) ? list.filter((key) => typeof key === 'string') : []);
  return { allow: keys(value?.allow), deny: keys(value?.deny) };
}

function normalizeBotRules(value: any): BotRules {
  const roles: Record<string, BotRule> = {};
  for (const [roleId, rule] of Object.entries(value?.roles || {})) roles[roleId] = normalizeBotRule(rule);
  return { everyone: normalizeBotRule(value?.everyone), roles };
}

function normalizeColors(value: any) {
  const colors = (Array.isArray(value) ? value : [])
    .map((color) => normalizeColor(color, ''))
    .filter(Boolean)
    .slice(0, 8);
  return colors.length >= 1 ? colors : [DEFAULT_ROLE_COLOR];
}

function normalizeColor(value: any, fallback: string) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function toHex(value: any, fallback: string) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function parseGradient(value: any): { angle: number; colors: string[] } | null {
  const match = String(value || '').match(/^linear-gradient\(\s*(-?\d+(?:\.\d+)?)deg\s*,\s*(.+)\)$/i);
  if (!match) return null;
  const stops = match[2].split(',').map((part) => part.trim().split(/\s+/)[0]).filter((color) => /^#[0-9a-f]{6}$/i.test(color));
  return stops.length >= 2 ? { angle: clampAngle(Number(match[1])), colors: stops.slice(0, 8) } : null;
}

function clampAngle(value: any) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.min(360, Math.max(0, number)));
}

function normalizeText(value: any, fallback: string) {
  const text = String(value || '').trim();
  return text || fallback;
}

function hasBit(value: number, bit: number) {
  return Math.floor(value / bit) % 2 === 1;
}

function addBit(value: number, bit: number) {
  return hasBit(value, bit) ? value : value + bit;
}

function removeBit(value: number, bit: number) {
  return hasBit(value, bit) ? value - bit : value;
}

function getPermissionState(permissions: PermissionOverride, bit: number) {
  if (hasBit(permissions.allow || 0, bit)) return 'allow';
  if (hasBit(permissions.deny || 0, bit)) return 'deny';
  return 'inherit';
}

async function loadConfig() { return getJson('/api/config'); }
async function loadRoles() { return (await getJson('/api/roles')).roles || []; }
async function createRole(body: any) { return postJson('/api/roles', body); }
async function updateRole(roleId: string, body: any) { return patchJson(`/api/roles/${encodeURIComponent(roleId)}`, body); }
async function duplicateRole(roleId: string, name: string) { return postJson(`/api/roles/${encodeURIComponent(roleId)}/duplicate`, { name }); }
async function deleteRole(roleId: string) { return deleteJson(`/api/roles/${encodeURIComponent(roleId)}`); }
async function loadBotPermissions() { return getJson('/api/bot-permissions'); }

async function deleteJson(url: string) {
  const response = await fetch(API_BASE + url, { method: 'DELETE' });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

createRoot(document.getElementById('root')!).render(h(App));