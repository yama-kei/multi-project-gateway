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
  └── #intentlayer   ─┘     (single Discord bot)
                                │
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
- Auto-chunks messages at 2000 chars (Discord limit), splitting at newline boundaries to avoid breaking code blocks. Chunks sent as sequential messages with rate-limit awareness.

#### 2. Channel Router (`router.ts`)

- Looks up channel ID in config
- Returns project config (name, directory) or null for unmapped channels
- Discord threads inherit parent channel's routing and share the parent channel's session (v1 — thread-based isolation is a future enhancement)

#### 3. Session Manager (`session-manager.ts`)

- Manages a pool of Claude Code CLI subprocesses, one per project
- **Spawn**: On first message for a project, spawns Claude CLI using `child_process.spawn` with `{ cwd: project.directory }` to set the working directory (there is no `--project-dir` flag):
  ```
  spawn('claude', ['--print', '--dangerously-skip-permissions', '--output-format', 'stream-json', '<prompt>'], {
    cwd: '/home/yamakei/Documents/RallyHub'
  })
  ```
- **Resume**: For follow-up messages, uses `--resume <session_id>` with the prompt as a positional argument:
  ```
  spawn('claude', ['--print', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--resume', '<session_id>', '<prompt>'], {
    cwd: '/home/yamakei/Documents/RallyHub'
  })
  ```
  Note: Consider using `--session-id <uuid>` instead of `--resume` — this allows specifying a deterministic session ID per project upfront, simplifying session tracking.
- **Prompt delivery**: The user's message is passed as the final positional argument to the `claude` CLI, not via stdin.
- **Spawn-per-message model**: Each Discord message results in a new `claude --print` process invocation. The `--resume` flag provides conversational continuity across invocations without keeping a long-lived process. This avoids complexity of managing persistent bidirectional subprocesses.
- **Idle timeout**: 30 minutes of inactivity → discard session ID. Next message starts a fresh session (no process to kill since processes are short-lived per message).
- **Crash recovery**: If a process exits with non-zero status, log error, notify Discord channel. Next message spawns fresh.
- **Concurrency**: Different projects run in parallel (one process per project at a time). A global concurrency limit (default: 4) prevents resource exhaustion when many projects are active simultaneously.

#### 4. Claude CLI Wrapper (`claude-cli.ts`)

- Spawns `claude` as a child process via `child_process.spawn` with `cwd` set to the project directory
- Passes prompt as a positional argument (final arg)
- Parses `stream-json` output for response text and session metadata
- **Session ID extraction**: The `stream-json` output includes a `result` event at the end of each response containing `session_id`. The wrapper captures this for use with `--resume` on subsequent messages. The exact JSON shape should be verified against `claude --print --output-format stream-json` output during implementation.
- Returns collected response text to caller

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
    "RALLYHUB_CHANNEL_ID": {
      "name": "RallyHub",
      "directory": "/home/yamakei/Documents/RallyHub"
    },
    "MOCHI_CHANNEL_ID": {
      "name": "Mochi",
      "directory": "/home/yamakei/Documents/Mochi"
    },
    "TAKUMI_CHANNEL_ID": {
      "name": "Takumi",
      "directory": "/home/yamakei/Documents/Takumi"
    },
    "INTENTLAYER_CHANNEL_ID": {
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
   - **No**: Spawn `claude --print "<message>"` with `cwd` set to RallyHub directory
   - **Yes**: Spawn `claude --print --resume <session_id> "<message>"` with same `cwd`
5. Claude CLI process runs with the message as a positional argument
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
| Concurrent messages (different projects) | Run in parallel, up to global concurrency limit (default: 4) |
| `--resume` failure | Fall back to fresh session AND replay the current message into it |
| Attachments | Ignored in v1 (text messages only) |

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
