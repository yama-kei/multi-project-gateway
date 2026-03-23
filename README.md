# multi-project-gateway

A Discord bot that routes channel messages to per-project [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions. Each Discord channel maps to a local project directory, and the gateway manages Claude Code sessions, concurrency, and persistence automatically.

## How it works

```
Discord channel  ──▶  Router  ──▶  Session Manager  ──▶  claude --print
  (per project)        (channel → project)   (queue, resume, persist)     (in project dir)
                                                                              │
Discord reply    ◀──  Chunker  ◀──────────────────────  JSON response  ◀──────┘
```

1. User posts a message in a mapped Discord channel
2. Router resolves the channel to a project config
3. Session manager spawns `claude --print` in the project directory (or resumes an existing session)
4. Response is chunked to fit Discord's 2000-char limit and sent back
5. Sessions persist to disk and resume across gateway restarts

## Prerequisites

- **Node.js** 20+
- **Claude Code CLI** installed and authenticated (`claude` on PATH)
- **Discord bot** token ([create one here](https://discord.com/developers/applications))

## Quick start

```bash
git clone https://github.com/yama-kei/multi-project-gateway.git
cd multi-project-gateway
npm install
```

Create a `.env` file:

```
DISCORD_BOT_TOKEN=your-bot-token-here
```

Create or edit `config.json`:

```json
{
  "defaults": {
    "idleTimeoutMs": 1800000,
    "maxConcurrentSessions": 4,
    "claudeArgs": [
      "--dangerously-skip-permissions",
      "--output-format", "json"
    ]
  },
  "projects": {
    "DISCORD_CHANNEL_ID": {
      "name": "MyProject",
      "directory": "/absolute/path/to/project"
    }
  }
}
```

Start the gateway:

```bash
npm run dev       # development (no build step)
# or
npm run build && npm start   # production
```

## Configuration

### `config.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaults.idleTimeoutMs` | number | `1800000` (30 min) | Session idle timeout before cleanup |
| `defaults.maxConcurrentSessions` | number | `4` | Max concurrent Claude processes |
| `defaults.claudeArgs` | string[] | `["--dangerously-skip-permissions", "--output-format", "json"]` | Args passed to every `claude` invocation |
| `projects.<channelId>.name` | string | channel ID | Display name for the project |
| `projects.<channelId>.directory` | string | **required** | Absolute path to the project directory |
| `projects.<channelId>.idleTimeoutMs` | number | inherits default | Per-project idle timeout override |
| `projects.<channelId>.claudeArgs` | string[] | inherits default | Per-project Claude args override |

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |

## Architecture

| Module | Responsibility |
|--------|---------------|
| `src/index.ts` | Entry point — loads config, wires modules, handles graceful shutdown |
| `src/config.ts` | Validates and merges `config.json` with defaults |
| `src/router.ts` | Maps channel IDs to project configs (supports threads via parent lookup) |
| `src/session-manager.ts` | One session per project, queues concurrent messages, manages idle timeouts |
| `src/session-store.ts` | Persists session IDs to `.sessions.json` for resume across restarts |
| `src/claude-cli.ts` | Spawns `claude --print` subprocess, parses JSON output |
| `src/discord.ts` | Discord.js client, message routing, response chunking |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run with tsx (no build step) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm test` | Run tests once |
| `npm run test:watch` | Run tests in watch mode |

## Limitations

- **Text only** — attachments and embeds are not forwarded to Claude
- **One message at a time per project** — concurrent messages to the same project are queued
- **Threads share parent session** — no per-thread isolation
- **Local only** — the gateway runs on the same machine as the project directories

## License

MIT
