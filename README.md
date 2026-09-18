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

## Commands

### Tickets

| Command | Description | Permission |
|---------|-------------|------------|
| `!ticket open [reason]` | Open a new ticket (10-min cooldown) | Anyone |
| `!ticket panel` | Send a reaction panel; reacting with 🎫 opens a ticket | Manage Server |
| `!ticket close` | Close the current ticket (must be in a ticket channel) | Creator or staff |
| `!ticket delete` | Generate transcript, delete DB record, delete channel | Creator or staff |
| `!ticket transcript` | Generate one HTML transcript in `temp/` | Anyone in the channel |
| `!ticket setup <open> <closed> <transcript> <role>` | Configure ticket IDs at runtime | Manage Server |
| `!ticket help` | Show ticket help | Anyone |

### Welcome images

| Command | Description | Permission |
|---------|-------------|------------|
| `!welcomer editor` / `!welcome editor` | Start the localhost Canva-style editor (port 3030 by default) | Manage Server |
| `!welcome set <channelId>` | Set welcome channel and enable welcomes | Manage Server |
| `!welcome message <text>` | Set welcome message (`{user}`, `{mention}`, `{server}`, `{count}` placeholders) | Manage Server |
| `!welcome image <on\|off>` | Toggle generated welcome image | Manage Server |
| `!welcome background <hex\|color\|imageUrl>` | Configure welcome image background | Manage Server |
| `!welcome textcolor <hex\|color>` / `!welcome accent <hex\|color>` | Configure colors | Manage Server |
| `!welcome layout <classic\|compact\|banner>` | Configure layout | Manage Server |
| `!welcome status` / `!welcome test [channelId]` | Inspect or test configuration | Anyone / Manage Server |

### Roles & reactions

| Command | Description | Permission |
|---------|-------------|------------|
| `!roles add <messageId> <emoji> <roleId> [emoji roleId ...]` | Add reaction-role mappings to a message in the current channel | Manage Roles |
| `!roles remove <messageId> [emoji ...]` | Remove mappings (all if no emoji given) | Manage Roles |
| `!roles list` | List saved reaction-role messages | Anyone |
| `!roles gradient <roleId> <col1> <col2> [col3] [--angle 90]` | Set a CSS linear-gradient role color | Manage Roles |
| `!roles editor` | Start the localhost role editor | Manage Server |
| `!joinrole add <roleId>` | Auto-assign a role to every new member | Manage Roles |
| `!joinrole remove <roleId>` | Stop auto-assigning a role | Manage Roles |
| `!joinrole list` | List configured join roles | Anyone |
| `!joinrole clear` | Remove all join roles | Manage Roles |

### Bot permissions (per role)

The permission table in every command list below is the **default** rule. Each role — plus an `Everyone` rule that applies to all members — can override it per feature in the dashboard: **Roles → pick a role → Bot permissions**.

| Setting | Effect |
|---------|--------|
| `Inherit` | The default rule shown under the feature (the Stoat permission, the support role, or "anyone"). |
| `Allow` | Full access to that feature, including its management actions, without the Stoat permission. |
| `Deny` | The feature's commands are refused for members with that role. |

Rules resolve the way Stoat folds role overwrites: `Everyone` first, then the member's roles from the bottom of the role list to the top, and the highest role set to Allow or Deny wins (Deny wins between roles of equal rank). The server owner is never restricted, and a rule only applies to commands run in the server it was set in — a grant in one server never carries into another, so cross-server commands (`!sync`, `!backup`, `!reset`) are still checked against the target server's own rules.

Features cover tickets (use / staff / setup), moderation (cases, automod, `purge`, `perms`, antiraid, captcha), roles (reaction roles, join roles), community (leveling, welcome, stats, embeds, notify, free stuff, reminders, booru search, polls, giveaways, tags, economy, birthdays, voice rooms), automation (auto-responder, auto-react), music (use and DJ controls), and server operations (logs, sync, backup, reset, dashboard). Changes are written to `data/bot-permissions.json` and posted to the server log channel when logging is on.

### Stats channels

| Command | Description | Permission |
|---------|-------------|------------|
| `!stats add all <channelId> [label]` | Track all members in a channel | Manage Channels |
| `!stats add role <roleId> <channelId> [label]` | Track members for a specific role | Manage Channels |
| `!stats remove <channelId>` | Remove a stats channel config | Manage Channels |
| `!stats list` | List configured stats channels | Anyone |
| `!stats refresh` | Force refresh all stats channels | Anyone |

### Logs

| Command | Description | Permission |
|---------|-------------|------------|
| `!logs set <channelId>` | Set the log channel | Manage Server |
| `!logs disable` | Disable logging | Manage Server |
| `!logs status` | Show log status | Anyone |
| `!logs test` | Send a test log | Manage Server |
| `!logs debug` | Dump your member object shape (for diagnostics) | Manage Server |

### Moderation cases

| Command | Description | Permission |
|---------|-------------|------------|
| `!warn @user [reason]` | Record a warning; may trigger the escalation ladder | Manage Messages |
| `!mute @user [duration] [reason]` | Timeout a member (`!mute @user 2h spam`); falls back to a mute role when configured | Timeout Members |
| `!unmute @user [reason]` | Lift a mute early | Timeout Members |
| `!kick @user [reason]` | Kick a member | Kick Members |
| `!ban @user [duration] [reason]` | Ban; a duration makes it temporary and it is lifted automatically | Ban Members |
| `!unban <userId> [reason]` | Remove a ban | Ban Members |
| `!note @user <text>` | Staff-only note — the member is never told | Manage Messages |
| `!cases [@user]` / `!case <id>` | Case history, or one case in full | Manage Messages |
| `!case reason <id> <text>` / `!case delete <id>` | Edit or remove a record | Manage Messages (delete: Ban Members) |
| `!modstats` | Totals per action and the busiest moderators | Manage Messages |

Escalation rules ("3 warnings → 1h mute, 5 → ban"), the mute role, the case channel and DM notices are configured in the dashboard **Moderation** tab. Warnings older than the configured expiry stop counting toward escalation.

### Automod

| Command | Description | Permission |
|---------|-------------|------------|
| `!automod on` / `off` / `status` / `list` | Turn filtering on and inspect it | Manage Server |
| `!automod add <type> [action] [duration]` | Add a rule | Manage Server |
| `!automod words <id> add\|remove <word…>` | Edit a word list (`*` is a wildcard) | Manage Server |
| `!automod set <id> threshold\|action\|window\|name <value>` | Tune a rule | Manage Server |
| `!automod remove <id>` / `!automod toggle <id>` | Delete or pause a rule | Manage Server |
| `!automod exempt role\|channel <id>` | Toggle a server-wide exemption | Manage Server |

Rule types: `words`, `invites`, `links`, `mentions`, `spam`, `duplicates`, `caps`, `emoji`, `newlines`, `zalgo`, `attachments`. Actions: `delete` (remove the message only), `warn`, `mute`, `kick`, `ban` — the rest also delete the message and open a moderation case. Members holding Manage Messages, Manage Channel, Kick or Ban are exempt by default.

### Polls & giveaways

| Command | Description | Permission |
|---------|-------------|------------|
| `!poll "Question" "A" "B"` | Post a poll (up to 10 options); `--time 2h`, `--multi`, `--anon` | Manage Messages |
| `!poll list` / `!poll end <id>` / `!poll delete <id>` | Manage polls | Manage Messages |
| `!giveaway start 1h 2w <prize>` | Host a giveaway (`!gstart` is the same) | Manage Server |
| `!giveaway end <id>` / `reroll <id> [count]` / `list` / `info <id>` | Draw, redraw, inspect | Manage Server |

Giveaway flags: `--level N`, `--role <roleId>`, `--age N` (account age in days), `--bonus <roleId>:N` (extra entries), `--desc <text>`. Entry is a 🎉 reaction, and an ineligible member is told why immediately.

> **Renamed:** `!giveaway` and `!giveaways` used to open the Free Stuff feed (free games and deals). They now run your own giveaways, which is what those words mean to a member. The feed keeps its unambiguous names: `!freestuff`, `!free`, `!freegames`, `!deals`.

### Tags, economy, birthdays, voice rooms

| Command | Description | Permission |
|---------|-------------|------------|
| `!tag create <name> <content>` | Make `!<name>` answer with that content | Manage Messages |
| `!tag list` / `search` / `info` / `raw` / `alias` / `restrict` / `channel` | Manage tags | Manage Messages (read-only for `list`) |
| `!balance` / `!daily` / `!work` / `!pay @user <amount>` | Earn and move currency | Anyone |
| `!shop` / `!buy <item>` / `!inventory` / `!rich` / `!gamble <amount>` | Spend it | Anyone |
| `!eco on\|off\|status` / `!eco add\|remove\|set @user <amount>` / `!eco reset @user\|all` | Economy admin | Manage Server |
| `!birthday set <date>` / `remove` / `show` / `next` / `list` | Birthday registry | Anyone |
| `!birthday channel\|role\|hour\|offset\|message\|year\|test` | Birthday setup | Manage Server |
| `!vc create` / `name` / `limit` / `lock` / `unlock` / `claim` / `close` / `list` | Temporary voice rooms (after `!vc on`) | Anyone |
| `!vc on\|off\|status` / `!vc hub <id>` / `!vc notice <id>` | Voice room setup | Manage Server |

Tags resolve only after every built-in command has been ruled out, so a tag can never shadow `!ban`. Economy coins are deliberately separate from leveling XP: buying a role should not cost you rank. Stoat has no API for moving members between voice channels, so joining the hub posts a link to the new room rather than dragging the member into it.

### Embeds, moderation tools, backup

| Command | Description | Permission |
|---------|-------------|------------|
| `!embed editor` | Start the localhost embed editor | Manage Server |
| `!purge <count>` / `!masseliminate <count>` | Bulk delete messages in the current channel | Manage Messages |
| `!perms ...` / `!permissions ...` / `!massperms ...` | Bulk-edit channel permissions | Manage Permissions |
| `!backup create [name]` / `!backup list` / `!backup import <file> [--confirm]` | Server config snapshots — recreates channels, roles, permissions, bot data, and panel/ticket messages (via Masquerade) | Manage Server |
| `!backup preview <file> [targetServerId]` | Diff a backup against the live server: which names already exist, what would be created, which data files get overwritten. Changes nothing. | Manage Server |
| `!reset <serverId>` | Wipes the entire server (all channels, roles, categories, bot data). Requires terminal confirmation on the host machine — the operator must type `yes` within 60 seconds. | Manage Server + terminal |
| `!help` / `!help all` | Show categorized help | Anyone |

### Music

The bot needs **Connect** and **Speak** in the voice channel. Playback commands work for anyone in the bot's voice channel, and for members with Manage Server or Move Members.

| Command | Description | Permission |
|---------|-------------|------------|
| `!play <song\|link>` / `!p` | Join your voice channel and play or queue. Links: YouTube (videos, playlists, live), YouTube Music, SoundCloud, Spotify track/album/playlist, direct audio and radio stream URLs. Text search flags: `--sc` SoundCloud, `--ytm` YouTube Music (default YouTube) | In voice |
| `!playnext <song\|link>` / `!pn` | Same, but queued at the front | In voice |
| `!radio <stream link>` / `!fm` | Play an internet radio station. Streams: Icecast/SHOUTcast (`http`, `https`, `icy://`), HLS `.m3u8`, DASH `.mpd`, `rtsp://`, `rtmp://`, `mms://`; any codec ffmpeg decodes (MP3, AAC/AAC+, Opus, Vorbis, FLAC, NSV, WMA…). Playlist files: `.pls`, `.m3u`, `.asx`/`.wax`/`.wvx`, `.xspf`, `.ram`/`.rpm`, `.smil`, `.wpl`, `.b4s`, `.qtl`, `.strm`. The link's content decides what it is, so mislabeled playlists and extension-less links work too. Look up a station's stream links on [streamurl.link](https://streamurl.link/). Reads the station name, genre and bitrate, reconnects when the stream drops, and `!radio` with no link shows the song on air | In voice |
| `!search <query>` | Show 5 results; reply with a number to play one, `x` to cancel | In voice |
| `!join [channel]` / `!leave` | Join your (or the named) voice channel / disconnect and clear the queue | In voice |
| `!pause` / `!resume` / `!skip` / `!skipto <n>` / `!stop` | Playback controls (`stop` clears the queue but stays connected) | Bot's voice channel |
| `!queue [page]` / `!np` | Show the queue / now playing with progress | Anyone |
| `!remove <n>` / `!move <from> <to>` / `!shuffle` / `!clear` | Edit the queue | Bot's voice channel |
| `!loop [off\|track\|queue]` / `!volume <0-200>` | Repeat mode; volume (saved per server) | Bot's voice channel |
| `!lyrics [song]` | Lyrics for the current track or a search, from [LRCLIB](https://lrclib.net) | Anyone |
| `!player` | Reaction control panel: ⏯️ ⏭️ ⏹️ 🔁 🔀 🔉 🔊 (give the bot Manage Messages so it can reset pressed buttons) | Bot's voice channel |
| `!music announce on\|off` / `!music status` | Toggle "Now playing" messages / show yt-dlp version, ffmpeg, and whether the YouTube fast path is active | Manage Server / Anyone |

Spotify links need no API keys: track names come from Spotify's public embed page, and the audio is matched on YouTube Music when the track comes up.

YouTube goes through [youtubei.js](https://github.com/LuanRT/YouTube.js) first: searches, playlists and link lookups answer in well under a second, and videos that YouTube serves as plain audio files start playing in about 0.2 s. Label music and YouTube Music tracks are only served over YouTube's SABR protocol, which youtubei.js cannot stream, so those (and live streams) fall through to yt-dlp within a few hundred milliseconds and take about 2–3 s. To hide that wait, the next song in the queue starts downloading 45 seconds before the current one ends, so songs change over with no gap, and the first song after `!play` downloads while the bot is still joining the voice channel. Live streams are never fetched ahead. If youtubei.js keeps failing for other reasons (usually a YouTube change), the bot switches to yt-dlp only for 15 minutes; `!music status` shows which mode is active. The bot leaves after `MUSIC_IDLE_TIMEOUT_SEC` (default 180) with nothing playing or nobody else in the channel.

### Booru image search

| Command | Description | Permission |
|---------|-------------|------------|
| `!booru <site> [tags…]` | Post a random image from that site matching the tags | Anyone |
| `!<site> [tags…]` | Shortcut, e.g. `!danbooru cat_ears solo`, `!e926 fox`, `!derpi twilight_sparkle` | Anyone |
| `… -n <1-5>` | Post several results at once | Anyone |
| `!booru sites` | Every site, its shortcuts, and whether it is usable here | Anyone |
| `!booru settings` | This server's adult-content setting, blacklist and disabled sites | Anyone |
| `!booru blacklist add\|remove <tags…>` / `!booru blacklist clear` | Tags whose posts are never shown in this server | Manage Server |
| `!booru enable\|disable <site>` | Turn a site on or off in this server | Manage Server |
| `!booru nsfw on\|off` | Allow adult results in channels marked NSFW (on by default) | Manage Server |

Tags use each site's own syntax: `-tag` excludes, underscores stand for spaces, and on the Philomena sites (Derpibooru, Manebooru, Twibooru, Furbooru) `twilight_sparkle` is sent as `twilight sparkle`. The bot re-uploads the image (or attaches the video) so it shows inline; files over `BOORU_MAX_UPLOAD_MB` (default 20, Stoat's limit) are linked instead.

| Site | Shortcuts | Notes |
|------|-----------|-------|
| Danbooru | `danbooru` `dan` `db` | Two tags per search anonymously; a Gold account raises it |
| Safebooru | `safebooru` `sb` | |
| Gelbooru | `gelbooru` `gel` `gb` | Needs an account (user ID + API key) |
| TBIB | `tbib` `bigbooru` | |
| yande.re | `yandere` `yande` | |
| Konachan | `konachan` `kona` | |
| e621 / e926 | `e621`, `e926` | e926 is always safe-only; account optional (one account covers both) |
| Derpibooru | `derpibooru` `derpi` | Account (API key) optional |
| Manebooru | `manebooru` `mane` | |
| Twibooru | `twibooru` `twi` | |
| Furbooru | `furbooru` `furbu` | |
| e6AI | `e6ai` | AI-generated furry art |
| AllTheFallen | `atfbooru` `atf` `allthefallen` | NSFW channels only; Danbooru-compatible API |
| Rule34 | `rule34` `r34` | NSFW channels only; needs an account (user ID + API key) |
| Rule34 Paheal | `paheal` `r34p` | NSFW channels only; no random sort on the site, so the bot picks a random page |
| Xbooru | `xbooru` | NSFW channels only |
| Hypnohub | `hypnohub` | NSFW channels only |

Site accounts are added in the dashboard **Booru** tab, never in `.env`. Saving a key makes one real API call first and refuses a key the site rejects (with a "Save anyway" for when the site is down). Keys are shared by every server, encrypted with AES-256-GCM into `data/secrets.json`, and never sent back to the browser; share-link guests cannot see or change them. The master key is `YAOSB_SECRET_KEY` when set, otherwise a random key generated in `data/secret.key`. The same tab holds each server's adult-content switch, site toggles and blacklist.

Content rules, which a server cannot turn off:

- Outside channels marked NSFW (and in DMs), only general-rated posts are shown. The bot adds the site's safe-rating tag to the query and checks every result's rating again before posting it, and adult-only sites are refused.
- In NSFW channels every rating is allowed unless the server ran `!booru nsfw off`.
- Tags describing sexualised minors (`loli`, `shota` and similar) are refused as search terms and filtered out of every result at any rating; age-related tags such as `child` or `young` are filtered from anything rated above general. The server blacklist applies on top.
- A search that only returns filtered posts says how many were hidden instead of posting anything.


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

**JSON files** hold settings and everything else, written atomically (tmp file + rename) so a crash mid-write never corrupts a file:

- `tickets.json` — all ticket records
- `counter.json` — auto-incrementing ticket ID counter (type-coerced on read)
- `ticket-cooldowns.json` — per-user last-creation timestamps
- `config.json` — runtime config: the ticket IDs set via `!ticket setup` and the command prefix set in the dashboard
- `welcome.json` — per-server welcome settings and saved image designs
- `welcome-images.json` — saved welcome image designs (library)
- `custom-embeds.json` — saved custom embeds
- `join-roles.json` — auto-assigned role IDs per server
- `reaction-roles.json` — message → emoji → role mappings
- `stats-channels.json` — tracked stats channels
- `log-config.json` — log channel and enabled state
- `bot-permissions.json` — per-role Allow/Deny rules for the bot's own features, per server
- `branding.json` — the bot's display name and uploaded logo, set in the dashboard
- `modules.json` — which modules are switched on, and which of those switches were set by hand (bot-wide; not included in backups)
- `booru.json` — per-server booru settings (adult results on/off, tag blacklist, disabled sites)
- `automod.json` — per-server automod settings and filter rules (with their hit counts)
- `polls.json` — polls, their options and who voted for what
- `hosted-giveaways.json` — server-run giveaways, entrants and winners
- `tags.json` — server-defined custom commands
- `birthdays.json` — saved birthdays plus the announcement settings and the last announced day
- `tempvoice.json` — the join-to-create settings and the rooms currently open
- `secrets.json` — credentials saved in the dashboard (booru API keys), AES-256-GCM encrypted; not included in backups
- `secret.key` — the generated master key for `secrets.json` (absent when `YAOSB_SECRET_KEY` is set). Keep it private; deleting it makes saved keys unreadable

Example ticket record:

```json
{
  "0001": {
    "creatorId": "user_id",
    "creatorUsername": "Username",
    "reason": "Need help with...",
    "channelId": "channel_id",
    "status": "closed",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "closedAt": "2024-01-02T00:00:00.000Z",
    "closedBy": "staff_user_id",
    "closedByUsername": "StaffName"
  }
}
```

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
