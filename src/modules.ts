/**
 * Modules: bot-wide on/off switches for whole features, set from the dashboard
 * Modules tab.
 *
 * This is a different layer from each feature's own per-server "enabled"
 * setting. A per-server setting decides whether the feature acts in that
 * server; a module switch decides whether the bot runs the feature at all. A
 * module that is off costs nothing: its event handlers are skipped, its
 * scheduler is stopped, its commands answer with a pointer to this switch, and
 * for music the code is never even imported.
 *
 * Fresh installs start with every module off. A bot that ran before switches
 * existed keeps working: the first time a module has no recorded state, it is
 * switched on when its data file shows it was set up, and off otherwise. The
 * same rule covers modules added by later versions.
 *
 * Tickets, embeds, roles, purge, permissions, backups, reset, help and the
 * dashboard itself are the core and are always on.
 *
 * This file must stay free of feature imports: the command dispatcher, help
 * and the dashboard read it, and index.ts wires the lifecycle through
 * `onModuleChange`.
 */
import { existsSync, readFileSync } from 'fs';
import { dataFile, readDataFileContent, readJson, registerDataFileHooks, writeJson } from './json-store.js';
import { warn } from './logger.js';

export type ModuleGroup = 'Community' | 'Automation' | 'Safety' | 'Engagement' | 'Media' | 'Insights';

export type ModuleDef = {
  key: string;
  label: string;
  group: ModuleGroup;
  /** What the module does, one sentence. */
  description: string;
  /** What running it costs, so the dashboard can say what switching it off saves. */
  cost: string;
  /** Bot-permission features whose commands belong to this module. */
  features: string[];
  /** Data files whose contents show the module was set up before switches existed. */
  dataFiles: string[];
};

export const MODULE_GROUPS: ModuleGroup[] = ['Community', 'Automation', 'Safety', 'Engagement', 'Media', 'Insights'];

export const MODULES: ModuleDef[] = [
  {
    key: 'welcome',
    label: 'Welcome messages',
    group: 'Community',
    description: 'Greets new members with a message and a rendered welcome card.',
    cost: 'A join handler, plus an image render per join.',
    features: ['welcome'],
    dataFiles: ['welcome.json', 'welcome-images.json'],
  },
  {
    key: 'joinroles',
    label: 'Join roles',
    group: 'Community',
    description: 'Gives configured roles to every new member.',
    cost: 'A join handler.',
    features: ['joinroles'],
    dataFiles: ['join-roles.json'],
  },
  {
    key: 'reactionroles',
    label: 'Reaction roles',
    group: 'Community',
    description: 'Grants and removes roles when members react to set messages. The roles command stays available.',
    cost: 'A lookup on every reaction.',
    features: [],
    dataFiles: ['reaction-roles.json'],
  },
  {
    key: 'tempvoice',
    label: 'Temporary voice rooms',
    group: 'Community',
    description: 'Lets members spawn voice rooms that delete themselves once empty.',
    cost: 'A handler on every voice packet and a sweeper timer.',
    features: ['tempvoice'],
    dataFiles: ['tempvoice.json'],
  },
  {
    key: 'birthdays',
    label: 'Birthdays',
    group: 'Community',
    description: 'Birthday registry and announcements.',
    cost: 'A scheduler waking every 10 minutes.',
    features: ['birthdays'],
    dataFiles: ['birthdays.json'],
  },
  {
    key: 'tags',
    label: 'Tags',
    group: 'Community',
    description: 'Server-defined custom commands.',
    cost: 'A lookup for every unknown command.',
    features: ['tags'],
    dataFiles: ['tags.json'],
  },
  {
    key: 'autoresponder',
    label: 'Auto responder',
    group: 'Automation',
    description: 'Replies to messages that match keywords.',
    cost: 'A pattern check on every message.',
    features: ['autoresponder'],
    dataFiles: ['autoresponders.json'],
  },
  {
    key: 'autoreact',
    label: 'Auto react',
    group: 'Automation',
    description: 'Adds reactions to messages that match patterns.',
    cost: 'A pattern check on every message.',
    features: ['autoreact'],
    dataFiles: ['autoreacts.json'],
  },
  {
    key: 'reminders',
    label: 'Reminders',
    group: 'Automation',
    description: 'Scheduled and recurring messages.',
    cost: 'A scheduler timer.',
    features: ['reminder'],
    dataFiles: ['reminders.json'],
  },
  {
    key: 'sync',
    label: 'Channel sync',
    group: 'Automation',
    description: 'Mirrors messages, edits and deletes between linked channels.',
    cost: 'A check on every message, edit and delete; a catch-up scan on every reconnect.',
    features: ['sync'],
    dataFiles: ['channel-syncs.json'],
  },
  {
    key: 'notify',
    label: 'Social notifications',
    group: 'Automation',
    description: 'Posts new streams, videos and posts from followed accounts.',
    cost: 'Polls every subscription each minute; some sources start a headless browser.',
    features: ['notify'],
    dataFiles: ['notify-subscriptions.json'],
  },
  {
    key: 'freestuff',
    label: 'Free Stuff',
    group: 'Automation',
    description: 'Posts free games and deals.',
    cost: 'Polls the deal feeds every 10 minutes.',
    features: ['freestuff'],
    dataFiles: ['freestuff-config.json'],
  },
  {
    key: 'antiraid',
    label: 'Antiraid',
    group: 'Safety',
    description: 'Join-flood detection, account-age gate and honeypot channel.',
    cost: 'A join handler and a check on every message.',
    features: ['antiraid'],
    dataFiles: ['antiraid.json'],
  },
  {
    key: 'captcha',
    label: 'Captcha',
    group: 'Safety',
    description: 'DMs new members an image challenge before granting a role.',
    cost: 'Join, DM and reaction handlers, plus an image render per challenge.',
    features: ['captcha'],
    dataFiles: ['captcha.json'],
  },
  {
    key: 'automod',
    label: 'Automod',
    group: 'Safety',
    description: 'Content filters: words, invites, spam, caps, mentions.',
    cost: 'Rule checks on every message.',
    features: ['automod'],
    dataFiles: ['automod.json'],
  },
  {
    key: 'moderation',
    label: 'Moderation',
    group: 'Safety',
    description: 'Warn, mute, kick and ban with case history and escalation.',
    cost: 'Commands only. Timed mutes and bans are still lifted on time while it is off.',
    features: ['moderation'],
    dataFiles: ['moderation.json'],
  },
  {
    key: 'logs',
    label: 'Server logs',
    group: 'Safety',
    description: 'Logs edits, deletes, joins, leaves and role or channel changes.',
    cost: 'Handlers on most server events; loads member lists at boot.',
    features: ['logs'],
    dataFiles: ['log-config.json'],
  },
  {
    key: 'leveling',
    label: 'Leveling',
    group: 'Engagement',
    description: 'XP per message, rank cards, leaderboards and level roles.',
    cost: 'Work on every message.',
    features: ['level'],
    dataFiles: ['leveling.json'],
  },
  {
    key: 'economy',
    label: 'Economy',
    group: 'Engagement',
    description: 'Currency earned by chatting, daily rewards and a shop.',
    cost: 'Work on every message.',
    features: ['economy'],
    dataFiles: ['economy.json'],
  },
  {
    key: 'polls',
    label: 'Polls',
    group: 'Engagement',
    description: 'Reaction polls with optional auto-close.',
    cost: 'A timer every 15 seconds and a lookup on every reaction.',
    features: ['polls'],
    dataFiles: ['polls.json'],
  },
  {
    key: 'giveaways',
    label: 'Giveaways',
    group: 'Engagement',
    description: 'Hosted giveaways with entry requirements and rerolls.',
    cost: 'A timer every 15 seconds and a lookup on every reaction.',
    features: ['giveaways'],
    dataFiles: ['hosted-giveaways.json'],
  },
  {
    key: 'music',
    label: 'Music',
    group: 'Media',
    description: 'Plays YouTube, SoundCloud, Spotify links and radio in voice channels.',
    cost: 'The heaviest module: ~3 s of extra startup and tens of MB of memory, plus yt-dlp upkeep and a YouTube session.',
    features: ['music', 'music.dj'],
    dataFiles: ['music.json'],
  },
  {
    key: 'booru',
    label: 'Booru search',
    group: 'Media',
    description: 'Image search across booru sites.',
    cost: 'Nothing until used.',
    features: ['booru'],
    dataFiles: ['booru.json'],
  },
  {
    key: 'stats',
    label: 'Stats channels',
    group: 'Insights',
    description: 'Channel names that count members or members with a role.',
    cost: 'A refresh every 5 minutes and on joins, leaves and role changes.',
    features: ['stats'],
    dataFiles: ['stats-channels.json'],
  },
  {
    key: 'analytics',
    label: 'Activity & analytics',
    group: 'Insights',
    description: 'Message, voice, join and command counters for the Overview and Analytics tabs.',
    cost: 'A counter update on every message and voice packet.',
    features: [],
    dataFiles: ['activity.json', 'analytics.json'],
  },
];

const MODULES_BY_KEY = new Map(MODULES.map((def) => [def.key, def]));
const MODULE_BY_FEATURE = new Map(MODULES.flatMap((def) => def.features.map((feature) => [feature, def] as const)));

/**
 * `enabled` holds every switch. `chosen` lists the ones the owner flipped by
 * hand; the rest were decided from the data files, and follow the data when a
 * backup restore brings new setup in (see `redetectModules`).
 */
type ModulesFile = { version: 1; enabled: Record<string, boolean>; chosen?: string[] };

const MODULES_FILE_NAME = 'modules.json';
const MODULES_FILE = dataFile(MODULES_FILE_NAME);

let state: Record<string, boolean> | null = null;
let chosen = new Set<string>();
const listeners: Array<(key: string, enabled: boolean) => void> = [];

// A backup restore replaces the file: reread it, and start or stop whatever the
// restored switches changed, as if they had been flipped in the dashboard.
registerDataFileHooks(MODULES_FILE_NAME, {
  reload: () => {
    const before = state;
    state = null;
    if (!before) return;
    const after = loadState();
    for (const def of MODULES) {
      if (before[def.key] !== after[def.key]) notify(def.key, after[def.key]);
    }
  },
});

function notify(key: string, enabled: boolean): void {
  for (const listener of listeners) {
    try {
      listener(key, enabled);
    } catch (error) {
      warn(`modules: ${key} ${enabled ? 'start' : 'stop'} failed: ${(error as Error)?.message || error}`);
    }
  }
}

function save(): void {
  try {
    writeJson(MODULES_FILE, { version: 1, enabled: state || {}, chosen: [...chosen] } satisfies ModulesFile);
  } catch (error) {
    warn(`modules: could not save the module switches: ${(error as Error)?.message || error}`);
  }
}

function loadState(): Record<string, boolean> {
  if (state) return state;
  const stored = readJson<Partial<ModulesFile>>(MODULES_FILE, {});
  const enabled: Record<string, boolean> = {};
  const recorded = stored?.enabled && typeof stored.enabled === 'object' ? stored.enabled : {};
  chosen = new Set(Array.isArray(stored?.chosen) ? stored.chosen.filter((key) => MODULES_BY_KEY.has(key)) : []);
  let decided = false;
  for (const def of MODULES) {
    if (typeof recorded[def.key] === 'boolean') {
      enabled[def.key] = recorded[def.key];
    } else {
      // No recorded choice: on when the module was already set up, off otherwise.
      enabled[def.key] = detect(def);
      decided = true;
    }
  }
  state = enabled;
  if (decided) save();
  return state;
}

function detect(def: ModuleDef): boolean {
  return def.dataFiles.some(hasStoredSetup);
}

/**
 * After a backup restore wrote feature data: switch on any module the owner
 * never set by hand whose data now shows setup, so restoring onto a fresh
 * install does not leave the restored features silently off. Hand-set
 * switches are left alone. Returns the modules it switched on.
 */
export function redetectModules(): string[] {
  const current = loadState();
  const switchedOn: string[] = [];
  for (const def of MODULES) {
    if (chosen.has(def.key) || current[def.key]) continue;
    if (detect(def)) {
      current[def.key] = true;
      switchedOn.push(def.key);
    }
  }
  if (switchedOn.length) {
    save();
    for (const key of switchedOn) notify(key, true);
  }
  return switchedOn;
}

/**
 * Whether a data file holds real setup: any `true`, non-empty string or
 * non-empty list anywhere in it. An untouched default store (`{ "links": [] }`,
 * `{ "servers": {} }`) has none. Read without `readJson`, which would
 * rewrite an empty file — detection must not change anything.
 *
 * Stores that moved into SQLite are read in their old shape
 * (`readDataFileContent`); a file already imported into it is still checked
 * under its `.migrated.bak` name.
 */
function hasStoredSetup(fileName: string): boolean {
  try {
    const content = readDataFileContent(fileName);
    if (content !== undefined) return hasContent(content, 0);
    const migrated = `${dataFile(fileName)}.migrated.bak`;
    if (!existsSync(migrated)) return false;
    const raw = readFileSync(migrated, 'utf-8').trim();
    return raw ? hasContent(JSON.parse(raw), 0) : false;
  } catch {
    // Unreadable: keep the module on rather than silently dropping a feature.
    return true;
  }
}

function hasContent(value: unknown, depth: number): boolean {
  if (depth > 8) return true;
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') {
    return Object.values(value).some((child) => hasContent(child, depth + 1));
  }
  return false;
}

/** Whether a module is on. Unknown keys are core features, which are always on. */
export function isModuleEnabled(key: string): boolean {
  if (!MODULES_BY_KEY.has(key)) return true;
  return loadState()[key] === true;
}

/** The module a bot-permission feature belongs to, when it belongs to one. */
export function moduleForFeature(feature: string | undefined): ModuleDef | null {
  return feature ? MODULE_BY_FEATURE.get(feature) || null : null;
}

/** The switched-off module a command's feature belongs to, or null when it may run. */
export function disabledModuleForFeature(feature: string | undefined): ModuleDef | null {
  const def = moduleForFeature(feature);
  return def && !isModuleEnabled(def.key) ? def : null;
}

export function getModule(key: string): ModuleDef | null {
  return MODULES_BY_KEY.get(key) || null;
}

export type ModuleView = ModuleDef & { enabled: boolean };

export function listModules(): ModuleView[] {
  const current = loadState();
  return MODULES.map((def) => ({ ...def, enabled: current[def.key] === true }));
}

/** Switch a module on or off, save it, and tell the lifecycle listeners. */
export function setModuleEnabled(key: string, enabled: boolean): ModuleView {
  const def = MODULES_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown module: ${key}`);
  const current = loadState();
  const next = !!enabled;
  const changed = current[key] !== next;
  if (changed || !chosen.has(key)) {
    current[key] = next;
    chosen.add(key);
    // Written directly (not through `save`) so a failed write reaches the caller.
    writeJson(MODULES_FILE, { version: 1, enabled: current, chosen: [...chosen] } satisfies ModulesFile);
  }
  if (changed) notify(key, next);
  return { ...def, enabled: next };
}

/** Run `listener` whenever a module is switched on or off at runtime. */
export function onModuleChange(listener: (key: string, enabled: boolean) => void): void {
  listeners.push(listener);
}

/** The reply a command gets when its module is off. */
export function moduleOffMessage(def: ModuleDef): string {
  return `⏸️ The **${def.label}** module is switched off on this bot. The bot owner can turn it on in the dashboard, under **Modules**.`;
}
