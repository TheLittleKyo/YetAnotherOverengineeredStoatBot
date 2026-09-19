# 🤖 YetAnotherOverengineeredStoatBot — Stoat Ticket & Moderation Bot

A complete, production-ready moderation and ticket system for [Stoat](https://stoat.chat) servers, built on [`stoatbot.js`](https://www.npmjs.com/package/stoatbot.js) and TypeScript.

## Features

- **Ticket system** — open / close / delete / transcript, with reaction panel, per-ticket roles, auto-incrementing IDs, and 10-minute cooldown
- **HTML transcripts** — self-contained `.html` files with avatars, replies, attachments, embeds, system messages, date dividers, and markdown rendering (XSS-sanitized)
- **Welcome images** — Canva-style drag-and-drop editor on `localhost`, multiple text/image layers, custom fonts, playlists, 3 layouts (classic / compact / banner)
- **Reaction roles** — message-bound emoji → role mappings
- **Join roles** — auto-assign roles on member join
- **Stats channels** — member-count and role-count channels that refresh on an interval
- **Log system** — channel/member/role/message/server events logged to a configurable channel
- **Embed editor** — local Canva-style embed builder with live preview, saved library, and direct send
- **Role editor** — local editor for role name, color, gradient, hoist, and per-permission inherit/allow/deny
- **Moderation cases** — `warn` / `mute` / `kick` / `ban` / `unban` / `note`, each a numbered case with history, editable reasons, DM notices, temporary punishments that expire on their own, and a configurable escalation ladder
- **Automod** — per-rule filters for banned words (with wildcards), invites, links, mass mentions, message spam, repeated messages, caps, emoji spam, walls of text, zalgo and attachment floods; every action above a delete opens a moderation case
- **Polls** — reaction-counted votes, single or multiple choice, with optional auto-close and a published result
- **Giveaways** — host your own draw with entry requirements (level, role, account age), weighted bonus roles, rerolls, and winner DMs
- **Tags** — server-defined custom commands with aliases, placeholders, and per-role or per-channel limits
- **Economy** — a spendable currency separate from XP: message/daily/work earning, transfers with an optional tax, a shop that can grant roles, and opt-in gambling
- **Birthdays** — members register a date, announced on the day in the server's own timezone with an optional role for 24 hours
- **Temporary voice rooms** — a join-to-create hub, owner controls (rename, limit, lock, claim), and rooms that close once empty
- **Analytics** — joins and leaves per day, busiest hours and weekdays, top channels, voice minutes, and command usage
- **Purge / mass permissions** — bulk delete messages and bulk-edit channel permissions
- **Backup / restore** — full server config snapshot to JSON, restorable from chat, with a `preview` that diffs a backup against the live server first
- **Bot audit log + health panel** — who changed the bot's own configuration, plus live event/error/scheduler counters in the dashboard Ops tab
- **Music** — voice-channel playback from YouTube, YouTube Music, SoundCloud, Spotify links, radio streams and anything else yt-dlp reads; queue, loop, shuffle, volume, lyrics, and a reaction control panel (feature set modelled on [Remix](https://github.com/remix-bot/stoat), running on stoatbot.js' built-in LiveKit voice)
- **Booru image search** — random posts by tag from Danbooru, Safebooru, Gelbooru, TBIB, yande.re, Konachan, e621/e926, e6AI, AllTheFallen, Derpibooru, Manebooru, Twibooru, Furbooru, Rule34, Rule34 Paheal, Xbooru and Hypnohub, with adult results limited to NSFW channels and a per-server tag blacklist
- **Crash-safe storage** — settings in JSON files written through tmp-file + rename; XP, balances, counters, cases and the audit log in SQLite (`data/bot.db`, built into Node), written row by row
- **Graceful shutdown** — SIGINT/SIGTERM closes HTTP editors, logs out, then exits with a 6s force-exit timeout

## Requirements

- Node.js v22.15.0 LTS or higher
- A Stoat bot account
- A Stoat server where the bot has: Manage Channels, Manage Permissions/Roles, Send Messages, Upload Files, Read Message History
- For music only: [`ffmpeg`](https://ffmpeg.org/download.html) on PATH (or set `FFMPEG_PATH`). No Python or Deno needed: the bot downloads the official [yt-dlp](https://github.com/yt-dlp/yt-dlp) release into `bin/` on first start, verifies its SHA-256 against the release checksums, checks for a new release daily (and right away when YouTube starts rejecting it), and lets yt-dlp use the bot's own Node.js to solve YouTube's JavaScript challenges. It prefers the unpacked "onedir" build, which starts about a second faster per song than the single-file build; each version gets its own `bin/yt-dlp-<version>-…` folder, and old folders are deleted once nothing runs from them. Set `YTDLP_PATH` to use your own yt-dlp instead; it is then never updated. On platforms without an official build (BSD, 32-bit ARM musl) the bot uses `yt-dlp` from PATH.
- For notification providers only: `npm install` also downloads a Chrome build (~150-200 MB) via `puppeteer`. One provider (Pomf.TV) uses it to pass a Cloudflare JS challenge; if Chrome is missing or cannot launch, that provider is skipped and everything else runs normally. In a container or as root, set `PUPPETEER_NO_SANDBOX=1`.
- For dashboard share links only: `cloudflared`. Windows and Linux download it automatically; macOS needs `brew install cloudflared` (see [Share links](#share-links-remote-dashboard-access)).

## Setup

### 1. Install dependencies

```bash
npm install
# or
bun install
```

`bun.lock` is the committed lockfile, so `bun install` reproduces the exact
dependency versions this project is tested against. `npm install` works too,
but resolves fresh versions within the ranges in `package.json`.

### 2. Create your Stoat bot

1. Go to your Stoat settings → "My Bots" → create a new bot
2. Copy the bot token

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in:

```env
BOT_TOKEN=your_bot_token_here
# Optional: override the dashboard's default port (3030)
# DASHBOARD_PORT=3030
```

That is all a first run needs. Anything the dashboard can set is not in `.env.example`, because the dashboard stores it in `data/` and that copy wins:

- the bot's display name and logo — **Server setup → Branding**
- the command prefix — **Server setup → Commands**
- the ticket categories, transcript channel and support role — **Server setup → Tickets** (or `!ticket setup`, see below)
- which server the dashboard controls — the sidebar server switcher
- join roles, stats channels, server logs, booru site keys — their own tabs

The environment is still read as the fallback for `BOT_NAME`, `PREFIX`, `SERVER_ID` and the four ticket IDs (`OPEN_TICKETS_CATEGORY_ID`, `CLOSED_TICKETS_CATEGORY_ID`, `TRANSCRIPT_CHANNEL_ID`, `SUPPORT_ROLE_ID`), so set them there instead if you would rather keep the config in one file.

### 4. Invite the bot to your server

Give it: Manage Channels, Manage Permissions, Manage Roles, Send Messages, Upload Files, Read Message History, React, Manage Messages.

### 5. Start the bot

```bash
npm start
# or for development with auto-restart:
npm run dev
```

### 6. Configure the ticket system at runtime (recommended)

Once the bot is online, an admin with **Manage Server** runs:

```
!ticket setup <openCategoryId> <closedCategoryId> <transcriptChannelId> <supportRoleId>
```

IDs can be raw or tagged (`<#channelId>`, `<%roleId>`). The values are stored in `data/config.json` and override anything in `.env`.

### 7. Switch on the features you want

Open `!dashboard` → **Modules**. Every feature beyond the core (tickets, embeds, roles, purge, permissions, backups, dashboard) is a module with a bot-wide on/off switch, and a fresh install starts with all of them **off**. A switched-off module costs nothing: its event handlers and timers do not run, its commands reply that it is off, and it is hidden from `!help`. Music, the heaviest one, is not even loaded until it is switched on or used.

Upgrading from a version without modules changes nothing: on first start, each module whose saved data shows it was set up is switched on, and the rest stay off. Restoring a backup does the same for modules you have not switched by hand. The switches are stored in `data/modules.json`.

### Clear all saved bot data

```bash
npm run clear:data
```
Stop the bot first: it keeps `data/bot.db` open, and Windows will not delete an open file. This deletes and recreates the whole local `data/` directory — including `data/backups/`, unlike `!reset`. It does **not** touch `.env`, source files, dependencies, transcripts in `temp/`, or anything on Stoat itself. Both this script and `!reset` honour `YAOSB_DATA_DIR`, so an instance pointed at another data directory clears that one.

## Project Structure

```
stoat-ticket-bot/
├── src/
│   ├── index.ts                # Entry point, event handlers, graceful shutdown
│   ├── config.ts               # .env + runtime config.json (atomic writes)
│   ├── branding.ts             # Dashboard-editable bot name + logo (data/branding.json)
│   ├── db.ts                   # SQLite storage (data/bot.db): schema, migrations, JSON import
│   ├── modules.ts              # Bot-wide module switches (data/modules.json)
│   ├── modules-editor.ts       # Dashboard Modules tab
│   ├── svg-render.ts           # Off-main-thread SVG → PNG for welcome cards and captchas
│   ├── database.ts             # Ticket storage (atomic writes, auto-heal)
│   ├── permissions.ts          # Permission bitfield + requirePermission() guard
│   ├── transcript.ts           # HTML transcript generator (XSS-sanitized)
│   ├── welcome.ts              # Welcome rendering + scheduling
│   ├── welcome-editor.ts       # Local Canva-style welcome editor HTTP server
│   ├── role-editor.ts          # Local role editor HTTP server
│   ├── embed-editor.ts         # Local embed editor HTTP server
│   ├── reaction-roles.ts       # Reaction-role mappings storage
│   ├── join-roles.ts           # Join-role auto-assignment
│   ├── log-system.ts           # Moderation log dispatcher
│   ├── stats.ts                # Stats channel refresh
│   ├── category-utils.ts       # Channel category move strategy
│   ├── backup.ts               # Server config backup/restore
│   ├── backup-preview.ts       # Read-only diff of a backup against the live server
│   ├── moderation.ts           # Case system: warn/mute/kick/ban, escalation, expiry scheduler
│   ├── automod.ts              # Message filters; punishments handed to moderation.ts
│   ├── polls.ts                # Reaction-counted votes with auto-close
│   ├── hosted-giveaways.ts     # Server-run draws (distinct from the free-stuff feed)
│   ├── tags.ts                 # Server-defined custom commands
│   ├── economy.ts              # Currency, shop, transfers, gambling
│   ├── birthdays.ts            # Birthday registry + timezone-aware announcements
│   ├── tempvoice.ts            # Join-to-create voice rooms and their sweeper
│   ├── analytics.ts            # Churn, per-channel/hour counters, voice time, command usage
│   ├── audit.ts                # Who changed the bot's own configuration
│   ├── health.ts               # In-memory runtime counters for the ops panel
│   ├── duration.ts             # Shared "10m" / "2h30m" / "permanent" parsing
│   ├── clear-data.ts           # `npm run clear:data` script
│   ├── booru/                  # Booru search: sites, engines, accounts, content filter, settings
│   ├── booru-editor.ts         # Dashboard Booru tab (server settings + encrypted site accounts)
│   ├── secret-store.ts         # AES-256-GCM store for dashboard-entered credentials
│   ├── commands/               # Chat command handlers
│   │   ├── index.ts            # Command router
│   │   ├── ticket-open.ts      # Ticket creation (cooldown-race-safe)
│   │   ├── ticket-close.ts
│   │   ├── ticket-delete.ts
│   │   ├── ticket-transcript.ts
│   │   ├── ticket-panel.ts
│   │   ├── ticket-setup.ts
│   │   ├── welcome.ts
│   │   ├── roles.ts
│   │   ├── joinrole.ts
│   │   ├── stats.ts
│   │   ├── logs.ts
│   │   ├── embed.ts
│   │   ├── purge.ts
│   │   ├── permissions.ts
│   │   ├── backup.ts
│   │   ├── moderation.ts       # warn / mute / kick / ban / cases
│   │   ├── automod.ts
│   │   ├── poll.ts
│   │   ├── giveaway.ts
│   │   ├── tag.ts
│   │   ├── economy.ts
│   │   ├── birthday.ts
│   │   ├── tempvoice.ts
│   │   └── help.ts
│   └── editors/                # Browser UI assets served by local editors
│       ├── shared/             # tokens.css + Select / SaveBar / dialog primitives
│       ├── embed/              # app.ts (React) + style.css — one folder per dashboard tab
│       ├── moderation/         # cases, escalation ladder, mute settings
│       ├── automod/            # filter rules and exemptions
│       ├── engagement/         # polls + giveaways
│       ├── community/          # tags, birthdays, voice rooms
│       ├── economy/            # currency, shop, balances
│       ├── analytics/          # churn, hours, channels, command usage
│       ├── role/
│       └── welcome/
├── assets/
│   └── logo.svg                # Default bot logo (until one is uploaded)
├── data/                       # Persistent data (auto-created)
├── temp/                       # Transcripts and uploads (auto-created)
├── .env.example
├── package.json
└── README.md
```

## Data Storage

All persistent state lives in the `data/` directory.

**SQLite (`bot.db`)** holds the stores that change on every message or keep growing: leveling XP, economy balances, activity and analytics counters, the bot audit log, moderation cases, and the channel-sync ledger. Each change is a single-row write committed straight away (WAL journal), so nothing waits in memory for a save, no save rewrites a whole file, and leaderboards come from an index. It uses Node's built-in `node:sqlite` (Node 22.13 or later), so there is nothing extra to install. `bot.db-wal` and `bot.db-shm` next to it are part of the database: copy or delete all three together, with the bot stopped.

Upgrading from a version that kept these in JSON files: each old file (`leveling.json`, `economy.json`, `activity.json`, `analytics.json`, `audit.json`, `moderation.json`, `channel-sync-messages.json`) is imported the first time its feature runs, then renamed to `<file>.migrated.bak` and never read again. Backups still carry economy and moderation as `economy.json` and `moderation.json`, in the same format as before, so older backups restore normally.

## Security

- **Permission gates** — every mutating command (`!ticket setup`, `!logs set/disable/test/debug`, `!joinrole add/remove/clear`, `!roles add/remove`, `!stats add/remove`, the welcome editor commands) requires the corresponding Stoat permission (Manage Server / Manage Roles / Manage Channels). Read-only commands (`list`, `status`) are open. Dashboard [bot permissions](#bot-permissions-per-role) can widen or narrow those gates per role, and are always evaluated against the server the command acts on.
- **Transcript XSS hardening** — user-supplied HTML in ticket messages is escaped before markdown parsing. Only the bot's own mention/emoji/spoiler/underline tags survive; `<script>`, `<img onerror=...>`, `<iframe>`, etc. are rendered as inert text. Code blocks and inline code are protected from transformation.
- **Atomic JSON writes** — `writeJsonFile` writes to `${path}.tmp` then renames, with a direct-write fallback if rename fails (cross-volume, Windows). The SQLite stores commit through a write-ahead log, so a crash loses at most the last few writes and never corrupts the file.
- **Encrypted credentials** — API keys entered in the dashboard are sealed with AES-256-GCM (name-bound, tamper-checked) before touching disk, are write-only from the browser, and are hidden from share-link guests. With the default generated key file, this protects `secrets.json` if it leaks on its own; anyone who can read the whole `data/` directory can still decrypt, so set `YAOSB_SECRET_KEY` to keep the key elsewhere.
- **Local-only dashboard** — the dashboard and every editor it hosts bind to `127.0.0.1` and have no login. Requests must carry a loopback `Host` header (DNS-rebinding guard) and mutating requests must be same-origin (CSRF guard). Do **not** bind it to `0.0.0.0` or put it behind a plain reverse proxy; to reach it from another machine, use a [share link](#share-links-remote-dashboard-access), which is token-authenticated.
- **Graceful shutdown** — SIGINT/SIGTERM close the editor HTTP servers, log out from Stoat, and force-exit after 6 seconds if anything hangs.

## Share links (remote dashboard access)

The dashboard is loopback-only, so the operator mints a **share link** to let
someone else open it from another machine. From the dashboard's share menu:

- A Cloudflare **quick tunnel** starts (`cloudflared tunnel --url`), publishing
  the dashboard at a random `https://<sub>.trycloudflare.com` address. No
  Cloudflare account, no inbound port opened - cloudflared dials out.
- `cloudflared` is found on `PATH`, or downloaded once into `data/bin/`. That
  auto-download covers Windows and Linux only; on macOS install it yourself
  (`brew install cloudflared`) or minting a link fails.
- Each link carries a 32-byte random token, a scope of **read** or
  **read-edit**, a TTL between 1 minute and 7 days (1 hour by default), and -
  unless you turn it off - a **single-use** bind to the first guest's browser
  session.
- Guests are confined to the server the link was minted for and can never reach
  the cross-server `sync`, `ops` and `debug` sections. Read-scope guests get 403 on any write.
- The tunnel shuts down on its own once every link has expired (checked every
  2 minutes), and links can be revoked from the dashboard at any time.

Anyone holding a live link has exactly the access that link grants, so treat the
URL like a password: send it over a private channel and revoke it when done.

## Backup & Restore

The `!backup` command exports the full server structure to `data/backups/<timestamp>-<name>.json` and can restore it into a (typically empty) target server.

### What gets backed up
- **Channels** — name, type, description, NSFW flag, voice settings, default permissions, role permission overrides
- **Roles** — name, colour, hoist, rank, permissions
- **Categories** — title and channel ordering
- **Server settings** — name, description, system messages, default permissions
- **Bot data** — the `data/*.json` feature files: tickets, reaction-roles, welcome config, stats channels, join roles, log config, custom embeds, welcome images, counter, cooldowns, bot permissions, moderation cases, automod rules, tags, economy, birthdays and temporary-voice settings. Channel and role ids inside them are remapped to the target server on restore.
- **Transcripts** — all `temp/transcript-*.html` files
- **Panel messages** — every reaction-role panel message's content + embeds + reactions + emoji→role mappings (captured by fetching the live message from the source server)
- **Ticket messages** — the initial bot embed for each open ticket channel
- **All channel messages** — every message in every text channel (up to 5000 per channel), captured with original author name + avatar URL + content + embeds + attachments + replies + reactions + timestamps, for full Masquerade replay

### Restore order
1. Create channels (with structure only, no permissions yet)
2. Create roles
3. Apply permissions (server default, role permissions, channel default, channel role overrides)
4. Restore bot data files (with IDs remapped to the new server)
5. **Recreate panel messages and ticket messages using Masquerade** — each captured message is re-sent in its new channel with `masquerade: { name: BOT_NAME, avatar: botAvatarUrl }` so it appears under the bot's name and avatar, original reactions are re-attached, and the stored message IDs in `reaction-roles.json` are updated to the new message IDs so reaction handlers still work
6. **Replay every channel message with per-message Masquerade** — each message is re-sent with `masquerade: { name: originalAuthorName, avatar: originalAuthorAvatarUrl }`, copying the original author's name AND profile picture. Reply chains are preserved (re-targeted to new message IDs), reactions are re-attached, and attachments are re-linked to the source CDN URLs. System messages are recreated as italicized text notes.
7. Refresh stats channels

### 403 Forbidden on permission restore
If you see `Could not restore channel role permissions for "<role>": ... 403 Forbidden`, the bot's role in the target server is either missing the **Manage Permissions** permission, or its role is below the target role in the role hierarchy. Fix: in the target server's **Server Settings → Roles**, drag the bot's role above every role it needs to manage, ensure it has Manage Permissions + Manage Roles + Manage Server, then re-run `!backup import <file> --confirm`. The bot will retry via three methods (SDK method → SDK REST wrapper → direct fetch with bot token) before giving up, so a 403 usually means a real hierarchy issue, not an API quirk.

### Masquerade permission
Message recreation uses Stoat's Masquerade feature (permission bit `1 << 28`). Grant the bot the **Masquerade** permission in the target server so recreated messages display as the original author's name and avatar instead of the bot's default account name. Without it, messages are still recreated but appear under the bot's raw username with no avatar. The bot does **not** set the masquerade `colour` field, so `ManageRole` is not required for Masquerade.

### Performance expectations
- **Backup time**: scales with message count. 100 messages takes ~1s; 1000 messages ~10s; 5000 messages (the per-channel cap) ~20s. The bot logs progress to the console with `[backup]` prefix.
- **Restore time**: roughly 350ms per message (intentional pacing to avoid Stoat's rate limits). 1000 messages ≈ 6 minutes; 5000 messages ≈ 30 minutes. The bot logs each channel's progress.
- **Per-channel cap**: 5000 messages per channel. Raise `MESSAGE_FETCH_MAX_PER_CHANNEL` in `src/backup.ts` if you need more.
- **Attachments**: image attachments (png/jpg/jpeg/gif/webp/bmp/svg/avif) are downloaded from the source CDN and re-uploaded as native `NodeFile` attachments so they render inline in the new server (25MB cap per file, 15s download timeout). Non-image attachments (videos, documents, audio) are re-linked to the source CDN URLs appended to message content, since Stoat's CDN URLs are public and persistent.
- **Rate limit handling**: on 429 during backup, the bot backs off 2s and retries the batch once. During restore, it paces sends at 350ms to avoid hitting limits in the first place.

### Backward compatibility
Old backup files created before full message capture was added still import fine — the `channelMessages`, `panelMessages`, and `ticketMessages` fields are all optional and default to empty. You'll just see `Channel messages recreated: 0` in the import summary for old backups.

## Reset Command (nuclear)

`!reset <serverId>` deletes every channel, every role (except the default `@everyone`), every category, and clears the local bot data files (`data/*.json`). Saved backups in `data/backups/` are kept. This is irreversible.

### Two-gate confirmation

1. **Chat gate**: The caller must have **Manage Server** permission in the target server.
2. **Terminal gate**: The host terminal operator must type `yes` within 60 seconds.

The terminal gate is the critical safety measure — even if a chat user with Manage Server goes rogue, the reset cannot proceed without physical access to the machine running the bot.

### What happens when you run `!reset <serverId>`

1. Bot verifies the caller has Manage Server permission
2. Bot resolves the server and counts channels/roles/categories
3. Bot sends a chat message with the counts and says "waiting for terminal confirmation"
4. Bot prints a prominent red banner to the host terminal:
   ```
   ⚠️  SERVER RESET REQUESTED  ⚠️
   ════════════════════════════════════════════════════════════════════
     Server:       <name>
     Server ID:    <id>
     Requested by: <username>
     Will delete:
       • N channel(s)
       • N role(s) (default @everyone preserved)
       • N categor(ies)
       • All local bot data files
   ════════════════════════════════════════════════════════════════════
     Type yes and press Enter to confirm.
     Type anything else (or wait 60s) to cancel.
   ════════════════════════════════════════════════════════════════════
   ```
5. The operator types `yes` (or `confirm` / `y`) and presses Enter, or waits 60 seconds / types anything else to cancel
6. If confirmed, the bot deletes:
   - All channels (one by one, 300ms pacing between deletes)
   - All roles except `@everyone` (roles above the bot's role in the hierarchy will fail with 403 — those are logged as errors but don't stop the wipe)
   - Server categories (cleared via `server.edit({ categories: [] })`)
   - All local bot data files (`data/*.json` — tickets, reaction-roles, welcome config, stats, logs, embeds, counter, cooldowns) and every row in `data/bot.db` (leveling, economy, activity, analytics, audit log, moderation cases, sync ledger). Subdirectories are left alone, so `data/backups/` survives the wipe
7. Bot sends a chat summary: `🧨 Server Wipe Complete` with deletion counts and any errors

### What is NOT deleted

- The server itself (it still exists, just empty)
- Saved backups (`data/backups/`) and downloaded binaries (`data/bin/`)
- The default `@everyone` role (Stoat doesn't allow this)
- The bot's membership in the server
- Messages in channels (deleting the channel deletes its messages implicitly)
- Anything on Stoat's side that isn't channels/roles/categories (server icon, banner, description — these are preserved)
- `.env` and source files

### Safety notes

- Only one pending reset at a time — if a reset is awaiting terminal confirmation, a second `!reset` will be rejected until the first completes or times out
- The 60-second timeout ensures the terminal doesn't hang forever if nobody is watching
- All deletions are logged to the console with `[reset]` prefix
- Role deletion failures (403 when bot's role is below the target role) are expected and logged as errors but don't abort the wipe — drag the bot role to the top of the hierarchy before resetting if you want every role deleted

## Customization

### Changing the command prefix

Dashboard → **Server setup → Commands**. Up to 8 characters, no spaces; the field shows the command it produces as you type. Saving applies it to the running bot at once — the command router reads it per message — and rebuilds the dashboard pages that print example commands. Clearing the field falls back to `PREFIX` in the environment, then to `!`:

```env
PREFIX=?
```

### Changing the name and logo

Open the dashboard, go to **Server setup → Branding**, and edit the display name or upload a logo (PNG, JPEG, GIF, WebP or SVG, up to 512KB). Both apply to the running bot at once — no restart. The name is what `config.botName` returns, so it covers the dashboard, page titles, transcripts, masqueraded messages and command replies; the logo is the sidebar mark and every page's favicon (the bot's Stoat avatar is set in Stoat, not here). The name saves with the page's **Save changes** bar; a picked logo uploads right away, and **Default** goes back to `assets/logo.svg`.

Branding is bot-wide rather than per server, so it is owner-only: a share-link guest never sees the card, and the API rejects the change even if the request is hand-crafted.

### Modifying transcript styles

Edit the CSS in `src/transcript.ts` in the `getStyles()` function.

### Modifying editor styles

Each editor has its own `src/editors/<name>/style.css`. All three share the same design tokens (`:root` variables at the top of each file) so you can change the palette once and propagate. The token set:

- `--bg`, `--panel`, `--panel-2`, `--input-bg` — surface tiers
- `--border`, `--border-strong`, `--border-focus` — borders
- `--text`, `--text-muted`, `--text-dim` — text tiers
- `--accent`, `--accent-hover`, `--accent-fg`, `--accent-soft` — primary accent
- `--danger`, `--ok` — semantic colors
- `--radius`, `--radius-lg`, `--font`, `--font-mono` — shape + type

### Adding new commands

1. Create a new file in `src/commands/`
2. Export an async function that takes `(message, args, client)`
3. Register it in `src/commands/index.ts`
4. If the command mutates server state, gate it with `requirePermission`:

```ts
import { requirePermission } from '../permissions.js';

export async function myCommand(message, args, client) {
  if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;
  // ... command body
}
```

## Troubleshooting

### Bot not responding
- Check that the bot token is correct
- Ensure the bot has been invited to the server
- Verify the bot has necessary permissions
- Check console output for error messages

### Tickets not being created
- Run `!ticket setup` to set category IDs, transcript channel, and support role
- Verify the bot has "Manage Channels" permission
- Look at console output for error messages

### Transcripts not sending
- Verify the transcript channel ID is correct
- Ensure the bot has "Upload Files" permission in that channel
- Check the `temp/` directory is writable

### Permission errors
- Ensure the bot's role is high enough in the hierarchy
- Verify all role IDs in configuration are correct

### Editor not opening
- The editors bind to `127.0.0.1` — open them on the same machine running the bot
- Default port: `3030` (override with `DASHBOARD_PORT`)
- If the port is taken, the editor auto-finds the next free port

## License

Copyright (C) 2026 YetAnotherOverengineeredStoatBot contributors.

YetAnotherOverengineeredStoatBot is free software licensed under the **GNU General Public License v3.0 or
later** — see [LICENSE](LICENSE) for the full text. You may run, study, modify,
and redistribute it, but any distributed derivative must also be released under
the GPL, with source available. It comes with ABSOLUTELY NO WARRANTY.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Acknowledgements

- [stoat.js](https://www.npmjs.com/package/stoat.js) — official Stoat JavaScript SDK
- [stoatbot.js](https://www.npmjs.com/package/stoatbot.js) — high-level bot framework
- [awesome-stoat](https://github.com/stoatchat/awesome-stoat) — community library list
- [marked](https://marked.js.org/) — markdown to HTML
- [@resvg/resvg-js](https://github.com/yisibl/resvg-js) — SVG to PNG for welcome images
