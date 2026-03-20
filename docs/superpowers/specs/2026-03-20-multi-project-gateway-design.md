# Multi-Project Discord Gateway — Design Spec

**Date**: 2026-03-20
**Status**: Approved
**Author**: yama_kei33 + Claude

## Problem

Managing multiple Claude Code sessions across different projects (RallyHub, Mochi, Takumi, intentLayer, etc.) requires manually switching between tmux tabs. The existing Discord plugin only supports one bot → one Claude Code session. There is no way to route Discord messages to different project sessions from a single bot.

## Solution

A standalone gateway service that connects one Discord bot to multiple Claude Code CLI sessions, routing messages by Discord channel.

## Architecture

```
Discord Server
  │
  ├── #rallyhub     ─┐
  ├── #mochi         │
  ├── #takumi        ├──▶  Multi-Project Gateway
  ├── #intentlayer   │     (single Discord bot)
  └── #general       ─┘         │
                                │  Channel Router
                                │  (channel ID → project config)
                                │
                          Session Manager
                         ┌──────┼──────┐
                         ▼      ▼      ▼
                      Claude  Claude  Claude
                      Code    Code    Code
                     (Rally) (Mochi) (Takumi)
                       Hub
```

### Components

#### 1. Discord Bot (`discord.ts`)

- discord.js v14, single bot token
- Listens for messages in configured channels
- Sends 👀 reaction on receipt
- Forwards message text to router
- Receives response from session, sends back to Discord channel
- Auto-chunks messages at 2000 chars (Discord limit)

#### 2. Channel Router (`router.ts`)

- Looks up channel ID in config
- Returns project config (name, directory) or null for unmapped channels
- Discord threads inherit parent channel's routing

#### 3. Session Manager (`session-manager.ts`)

- Manages a pool of Claude Code CLI subprocesses, one per project
- **Spawn**: On first message for a project, spawns:
  ```
  claude --print --dangerously-skip-permissions \
    --output-format stream-json \
    --project-dir <project_directory>
  ```
- **Resume**: For follow-up messages, uses `--resume <session_id>` to maintain conversational context
- **Idle timeout**: 30 minutes of inactivity → kill process, clean up session reference
- **Crash recovery**: If a process dies, log error, notify Discord channel, remove stale session. Next message spawns fresh.

#### 4. Claude CLI Wrapper (`claude-cli.ts`)

- Spawns `claude` as a child process via `child_process.spawn`
- Pipes message as input
- Parses `stream-json` output for response text
- Returns collected response to caller
- Tracks session ID from output for future `--resume`

#### 5. Config (`config.ts` + `config.json`)

- Loads and validates configuration on startup
- Bot token from environment variable

### Configuration

```json
{
  "defaults": {
    "idleTimeoutMs": 1800000,
    "claudeArgs": [
      "--dangerously-skip-permissions",
      "--output-format", "stream-json"
    ]
  },
  "projects": {
    "<CHANNEL_ID>": {
      "name": "RallyHub",
      "directory": "/home/yamakei/Documents/RallyHub"
    },
    "<CHANNEL_ID>": {
      "name": "Mochi",
      "directory": "/home/yamakei/Documents/Mochi"
    },
    "<CHANNEL_ID>": {
      "name": "Takumi",
      "directory": "/home/yamakei/Documents/Takumi"
    },
    "<CHANNEL_ID>": {
      "name": "intentLayer",
      "directory": "/home/yamakei/Documents/intentLayer"
    }
  }
}
```

Bot token is read from `DISCORD_BOT_TOKEN` environment variable (not stored in config file).

### Message Flow

1. User posts in `#rallyhub`: "Fix the auth bug in issue #42"
2. Gateway receives message, reacts with 👀
3. Router maps channel ID → RallyHub project config
4. Session manager checks: active session for RallyHub?
   - **No**: Spawn new `claude --print` process in `/home/yamakei/Documents/RallyHub`
   - **Yes**: Use `claude --print --resume <session_id>`
5. Message piped to Claude CLI subprocess
6. Claude works on the task (reads files, runs commands, edits code, etc.)
7. Response streamed back as JSON
8. Gateway parses response text, sends to `#rallyhub` channel
9. Idle timer reset to 30 minutes

### Error Handling

| Scenario | Behavior |
|---|---|
| Unmapped channel | Ignore silently |
| Session crash | Notify channel, remove stale session, next msg spawns fresh |
| Long-running task | 👀 on receipt, deliver final result when done |
| Concurrent messages (same project) | Queue, deliver after current response completes |
| `--resume` failure | Fall back to fresh session |

### Project Structure

```
multi-project-gateway/
├── src/
│   ├── index.ts           # Entry point
│   ├── discord.ts         # Discord bot setup + message handling
│   ├── router.ts          # Channel → project lookup
│   ├── session-manager.ts # Claude CLI process pool
│   ├── claude-cli.ts      # CLI subprocess wrapper
│   └── config.ts          # Config loader + validation
├── config.json            # Channel → project mapping
├── .env                   # DISCORD_BOT_TOKEN
├── package.json
└── tsconfig.json
```

### Tech Stack

- **Runtime**: Node.js + TypeScript
- **Discord**: discord.js v14
- **Process management**: Node `child_process.spawn`
- **No external dependencies** beyond discord.js

### Deployment

- Runs on the local development machine (same host as project repos)
- Single process: `npm start` or in a dedicated tmux session
- Replaces the need for multiple tmux tabs with Claude Code sessions

### Future Enhancements (not in v1)

- `/status` Discord command to see active/idle sessions
- Thread-based task isolation (new thread = new session for parallel work)
- GitHub webhook forwarding to project channels
- Teams integration (explicit command to spawn subagents)

### Non-Goals

- Not replacing the existing Discord plugin — this is a separate standalone service
- No agent-to-agent communication — user is the orchestrator
- No web UI — Discord is the interface
- No authentication beyond Discord's own (user is the only operator)
