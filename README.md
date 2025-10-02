# LockBot

LockBot is a reusable Discord bot helper built with [discord.js](https://discord.js.org) for placing servers in maintenance mode. The module can be imported in your own application or started directly from this repository. When maintenance is enabled, every member without the `Administrator` permission loses visibility of the server and is restricted to a temporary maintenance channel where you can post updates. Welcome messages are automatically redirected to this channel until maintenance is turned off; once maintenance ends they return to the guild's system channel when available.

## Features

- Slash command `/maintenance` with `enable`, `disable`, and `status` subcommands (administrator-only).
- Works across any guild the bot joins—no guild IDs hard-coded.
- Automatically hides every channel from non-admin roles while maintenance is active and restores previous visibility when complete.
- Creates a configurable, read-only maintenance text channel on demand.
- Any new channel created while maintenance is active is hidden from non-admins automatically.
- Optional auto-timeouts bring the server back online after a set duration.
- `/maintenance message` lets admins broadcast updates without leaving Discord.
- Polished embeds and in-channel buttons keep downtime announcements friendly and interactive.
- Redirects welcome messages to the maintenance channel while maintenance is enabled.

## Installation

```bash
npm install
```

## Usage as a Library

Create and start the bot from your own Node.js application:

```js
const { createLockBot } = require('./src');

const bot = createLockBot({
  token: process.env.DISCORD_TOKEN,
  maintenanceChannelName: 'maintenance', // optional override
  stateFile: 'data/state.json', // optional override
});

bot.login().catch((error) => {
  console.error('Failed to start LockBot', error);
});
```

You can further customise the bot by adjusting the `maintenanceChannelName`, supplying an alternate `stateFile`, or passing a different `logger` instance (defaults to `console`). Auto-timeouts and maintenance announcements are stored per guild, so they survive restarts.

## Usage from the CLI

1. Copy `.env.example` to `.env` and fill in your bot token and any optional values:

   ```bash
   cp .env.example .env
   ```

2. Register the slash commands (rerun this step whenever you change command definitions). If you provide `GUILD_ID`, commands are registered for that guild only; otherwise they deploy globally (which can take up to an hour to propagate):

   ```bash
   # With an env var
   GUILD_ID=1234567890 npm run register:commands

   # Or rely on the .env file (set GUILD_ID there if you prefer guild-only commands)
   npm run register:commands
   ```

3. Start the bot:

   ```bash
   npm start
   ```

## Commands

- `/maintenance enable [duration_minutes]` — Swap every non-admin/non-bot member into the zero-permission `maintenance-temp` role, strip `View Channel` from `@everyone`, open the maintenance room, and optionally auto-disable after the specified minutes.
- `/maintenance disable` — Restore saved role assignments, reapply the original `@everyone` permission state, and optionally remove the temporary maintenance channel/roles.
- `/maintenance status` — Display the current state, including any scheduled auto-timeout and the last broadcast message time.
- `/maintenance message <content>` — Post an update into the maintenance channel with a neat embed and interaction buttons.
- Maintenance channel buttons let members check the current status or get friendly guidance without pinging staff.
- Enable/disable commands prompt the initiating admin for confirmation before changes apply.
- Any permission edits you make during maintenance stick around—LockBot only reverts overwrites it is still actively enforcing.

During maintenance the bot automatically ensures two helper roles exist: `maintenance-temp` (assigned to all affected members) and `maintenance-bypass` (granting permanent visibility for staff you assign it to). Feel free to tweak permissions while maintenance is active—the bot only restores overwrites it is still enforcing, so any manual edits you make remain in place after the unlock.

## State Persistence

The bot keeps per-guild state in the JSON file configured by `stateFile` (defaults to `data/state.json`). That includes each locked member's original role list, auto-timeout settings, and announcement history. Do not delete this file while maintenance mode is active, otherwise role restoration may be incomplete.

## Troubleshooting

- If commands are missing, confirm they were registered (guild or global) and that the bot has restarted after registration.
- The bot needs permission to manage channel overwrites. Granting `Administrator` is the simplest approach.
- When adding the bot to additional guilds, run `/maintenance enable` in each as needed. No extra configuration is required.

## License

Licensed under the ISC License. Use or adapt to fit your needs.
