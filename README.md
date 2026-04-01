# multi-project-gateway

A Discord bot that routes channel messages to per-project [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions. Each Discord channel maps to a local project directory, and the gateway manages Claude Code sessions, concurrency, and persistence automatically.

## How it works

```
Discord channel  -->  Router  -->  Agent Dispatch  -->  Session Manager  -->  claude --print
  (per project)     (channel ->    (@mention ->         (queue, resume,       (in project dir)
                      project)       agent)               persist)                  |
                                       ^                                            |
                                       |--- auto-handoff if response has @mention <-'
                                                                                    |
Discord reply    <--  Chunker  <--------------------------  JSON response  <--------'
```

1. User posts a message in a mapped Discord channel
2. Router resolves the channel to a project config
3. If the message is in a main channel, the bot creates a thread for the response; if already in a thread, replies there directly
4. If agents are configured, agent dispatch routes via `@mention` or last active agent
5. Session manager spawns `claude --print` in the project directory (or resumes an existing session)
6. If the response contains an `@mention` of another agent, auto-handoff loops until done or turn limit reached
7. Response is chunked to fit Discord's 2000-char limit and sent back in the thread
8. Sessions persist to disk and resume across gateway restarts

## Security model

By default, each Claude session is restricted to its project directory using `--permission-mode acceptEdits`. This means:

- Claude can **read and edit files** within the project directory
- Claude **cannot access files** outside the project directory
- Claude **cannot run arbitrary shell commands** without approval (which is auto-denied in `--print` mode)

**Important considerations:**
- Anyone who can post in a mapped Discord channel can instruct Claude to read and modify files in that project's directory
- Only map channels that trusted users have access to
- Tool restrictions are enforced via `--allowed-tools` / `--disallowed-tools` (see [Tool security](#tool-security))
- For maximum access (e.g., in a sandboxed environment), you can set `claudeArgs` to use `--dangerously-skip-permissions`, but this gives Claude full OS-level access

### Tool security

The gateway restricts which tools Claude can use via `--allowed-tools` and `--disallowed-tools` CLI flags. By default, only safe file-system and read-only tools are allowed.

**Default allowlist:**

| Tool | Description | Security implications |
|------|-------------|----------------------|
| `Read` | Read file contents | Read-only. Can read any file in the project directory. |
| `Edit` | Edit existing files (patch-based) | Can modify existing files. Cannot create new files. |
| `Write` | Create or overwrite files | Can create new files or overwrite existing ones. |
| `Glob` | Find files by pattern | Read-only directory listing. Low risk. |
| `Grep` | Search file contents | Read-only content search. Low risk. |
| `Bash(git:*)` | Run git commands only | Restricted to `git` subcommands. Can commit, push, branch. Cannot run arbitrary shell commands. |
| `TodoWrite` | Write to Claude's internal todo list | No file-system side effects. |

**Tools NOT in the default allowlist (higher risk):**

| Tool | Risk | Why it is excluded |
|------|------|--------------------|
| `Bash` (unrestricted) | **High** | Full shell access: can run any command, install packages, access network, modify system files. |
| `WebSearch` / `WebFetch` | **Medium** | Network access: can exfiltrate data or fetch untrusted content. |
| `NotebookEdit` | **Low** | Jupyter notebook editing. Excluded for simplicity; add if needed. |

**Configuration examples:**

```json
{
  "defaults": {
    "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git:*)", "TodoWrite"]
  },
  "projects": {
    "TRUSTED_PROJECT_CHANNEL": {
      "directory": "/path/to/trusted-project",
      "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"]
    },
    "READ_ONLY_CHANNEL": {
      "directory": "/path/to/sensitive-project",
      "allowedTools": ["Read", "Glob", "Grep"]
    }
  }
}
```

**Override precedence:** per-project `allowedTools`/`disallowedTools` override gateway defaults. If both `allowedTools` and `disallowedTools` are set at the same level, `allowedTools` takes precedence (a warning is logged). If `claudeArgs` (at either the gateway or project level) already contains `--allowed-tools` or `--disallowed-tools`, the config-based tool restrictions are skipped to avoid conflicts.

> **Disallow-only mode:** When a project sets only `disallowedTools` without setting `allowedTools`, the gateway-level `allowedTools` default still applies (via fallback). This means the project inherits the default allowlist _and_ adds its disallow rules on top — but since `allowedTools` takes precedence over `disallowedTools`, the disallow list is effectively ignored. To use disallow-only mode (block specific tools while allowing everything else), explicitly set `"allowedTools": []` at the project level to clear the inherited allowlist.

## Prerequisites

- **Node.js** 20+
- **Claude Code CLI** installed and authenticated (`claude` on PATH)
- **Discord bot** token

## Setup guide

### 1. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to **Bot** in the sidebar
4. Click **Reset Token** and copy the token (you'll need it in step 3)
5. Enable **Message Content Intent** under Privileged Gateway Intents
6. If you plan to use **role-based access control** (`allowedRoles` in config), also enable the **Server Members Intent** (GuildMembers) under Privileged Gateway Intents. This is required for the bot to read member roles.
7. Go to **OAuth2 > URL Generator**, select the `bot` scope
8. Under Bot Permissions, select: **Send Messages**, **Read Message History**, **Add Reactions**
9. Copy the generated URL and open it in your browser to invite the bot to your server

### 2. Create Discord channels for your projects

Create a text channel for each project you want to manage (e.g., `#my-app`, `#my-api`). You'll need the channel IDs — enable Developer Mode in Discord settings (App Settings > Advanced > Developer Mode), then right-click a channel and select **Copy Channel ID**.

### 3. Install and configure the gateway

```bash
npm install -g multi-project-gateway
mpg init
```

This creates `.env` and `config.json` in the current directory. To store config centrally in `~/.mpg/` instead (recommended for worktrees and multi-config setups):

```bash
mpg init --profile default
```

The init wizard will:
- Check that `claude` CLI is available
- Ask for your Discord bot token
- Walk you through adding projects (name, directory path, channel ID)
- Generate `config.json` and `.env` (in CWD or `~/.mpg/profiles/<name>/` when using `--profile`)

Or set up manually by cloning:

```bash
git clone https://github.com/yama-kei/multi-project-gateway.git
cd multi-project-gateway
npm install
```

Create `.env`:

```
DISCORD_BOT_TOKEN=your-bot-token-here
```

Create `config.json`:

```json
{
  "defaults": {
    "idleTimeoutMs": 1800000,
    "maxConcurrentSessions": 4,
    "claudeArgs": [
      "--permission-mode", "acceptEdits",
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

### 4. Start the gateway

```bash
mpg start                    # if installed globally (uses default profile or CWD)
mpg start --profile dev      # use a named profile from ~/.mpg/
mpg start --config /path/to/config.json   # use an explicit config file
# or
npm run dev                  # development (no build step)
# or
npm run build && npm start   # production
```

You should see:

```
Loaded N project(s) from config
Gateway connected as YourBot#1234
```

### 5. Use it

Post a message in any mapped Discord channel. The bot reacts with an eye emoji, forwards your message to Claude Code running in the project directory, and sends back the response.

## CLI

```
mpg <command>

Commands:
  start     Start the gateway (default)
  init      Interactive setup wizard
  status    Show session status from disk
  logs      Show structured gateway logs
  help      Show help

Options:
  --profile <name>  Use a named profile (default: "default")
  --config <path>   Use a specific config.json path
  --migrate         Copy CWD config files into ~/.mpg/profiles/default/
  --level <level>   (logs) Filter by minimum log level (debug|info|warn|error)
```

## Config home (`~/.mpg/`)

By default, mpg resolves configuration from the current working directory. For multi-worktree setups or dev/prod separation, you can use a centralized config home at `~/.mpg/` (overridable via the `MPG_HOME` environment variable).

### Directory layout

```
~/.mpg/
├── .env                 # shared secrets (bot token)
├── profiles/
│   ├── default/
│   │   ├── config.json       # project/channel config
│   │   └── sessions.json     # runtime session state
│   └── dev/
│       ├── config.json
│       └── sessions.json
```

### Resolution order

**`.env` / secrets:**
1. Environment variables (already set) — highest priority
2. `$MPG_HOME/.env`
3. `$CWD/.env` — lowest priority, backward compat

**`config.json`:**
1. `--config <path>` CLI flag
2. `--profile <name>` resolves to `$MPG_HOME/profiles/<name>/config.json`
3. `$MPG_HOME/profiles/default/config.json`
4. `$CWD/config.json` — backward compat fallback

**`sessions.json`:** Always co-located with the resolved `config.json` (same directory).

### Setting up profiles

```bash
# Create a profile using the init wizard
mpg init --profile default

# Create a dev profile
mpg init --profile dev

# Start with a specific profile
mpg start --profile dev

# Or point to an explicit config file
mpg start --config /path/to/config.json
```

### Migrating from CWD-based setup

If you already have `.env`, `config.json`, and `.sessions.json` in your current directory:

```bash
mpg init --migrate
```

This copies your CWD files into `~/.mpg/profiles/default/` and prints what it did. The original files are left in place, so nothing breaks. No automatic migration is performed.

### Backward compatibility

If `~/.mpg/` does not exist and CWD files do, everything works exactly as before — zero breaking change.

## Configuration

### `config.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaults.idleTimeoutMs` | number | `1800000` (30 min) | Session idle timeout before cleanup |
| `defaults.maxConcurrentSessions` | number | `4` | Max concurrent Claude processes |
| `defaults.claudeArgs` | string[] | `["--permission-mode", "acceptEdits", "--output-format", "json"]` | Args passed to every `claude` invocation |
| `defaults.allowedTools` | string[] | `["Read", "Edit", "Write", "Glob", "Grep", "Bash(git:*)", "TodoWrite"]` | Tools Claude is allowed to use (see [Tool security](#tool-security)) |
| `defaults.disallowedTools` | string[] | `[]` | Tools Claude is forbidden from using (conflicts with `allowedTools`) |
| `defaults.maxTurnsPerAgent` | number | `5` | Max automatic handoffs in a single agent chain |
| `defaults.agentTimeoutMs` | number | `180000` (3 min) | Timeout per agent turn during auto-handoff |
| `defaults.sessionTtlMs` | number | `604800000` (7 days) | Max age for persisted sessions before pruning |
| `defaults.persistence` | string | — | Session runtime — set to `"tmux"` for persistent sessions that survive restarts |
| `defaults.maxPersistedSessions` | number | `50` | Max number of persisted sessions kept on disk |
| `defaults.httpPort` | number \| false | `3100` | Port for the web dashboard and API (`false` to disable) |
| `defaults.logLevel` | string | `"info"` | Minimum log level (`debug`, `info`, `warn`, `error`) |
| `projects.<channelId>.name` | string | channel ID | Display name for the project |
| `projects.<channelId>.directory` | string | **required** | Absolute path to the project directory |
| `projects.<channelId>.idleTimeoutMs` | number | inherits default | Per-project idle timeout override |
| `projects.<channelId>.claudeArgs` | string[] | inherits default | Per-project Claude args override |
| `projects.<channelId>.allowedTools` | string[] | inherits default | Per-project allowed tools override |
| `projects.<channelId>.disallowedTools` | string[] | inherits default | Per-project disallowed tools override |
| `projects.<channelId>.agents` | object | — | Named agents for this project (see [Multi-agent setup](#multi-agent-setup)) |
| `projects.<channelId>.allowedRoles` | string[] | — | Discord role names required to use this project (empty = no restriction) |
| `projects.<channelId>.rateLimitPerUser` | number | — | Max messages per user per minute for this project |

## Multi-agent setup

You can define multiple agents per project that collaborate via `@mentions`. Each agent gets its own Claude session with a dedicated system prompt, and agents can hand off work to each other automatically.

### Defining agents

Add an `agents` map to any project in `config.json`. Each key is the agent name (used as `@name` in Discord), with `role` and `prompt` fields. You can optionally set a per-agent `timeoutMs` to override `defaults.agentTimeoutMs`:

```json
{
  "projects": {
    "CHANNEL_ID": {
      "name": "my-app",
      "directory": "/path/to/my-app",
      "agents": {
        "pm": {
          "role": "Product Manager",
          "prompt": "You are the PM for my-app. Analyze requirements, create issues, and review work. When you need code implemented, mention @engineer in your response. Never write code directly.",
          "timeoutMs": 300000
        },
        "engineer": {
          "role": "Software Engineer",
          "prompt": "You are a senior engineer for my-app. Implement features, write tests, fix bugs, and create PRs. When work is done or you need PM review, mention @pm in your response.",
          "timeoutMs": 1800000
        }
      }
    }
  }
}
```

The timeout resolution order is: agent-specific `timeoutMs` → `defaults.agentTimeoutMs` (3 min).

### How agent routing works

```
User sends message
    |
    v
Contains @agentName? ── YES ──> Route to that agent
    |                            (session key: threadId:agentName)
    NO
    |
    v
In a thread with prior agent activity? ── YES ──> Route to last active agent
    |
    NO
    |
    v
Route to default session (no agent)
```

- **`@mention` routing:** Write `@pm fix the login bug` to target a specific agent. The mention is stripped from the prompt.
- **Plain reply routing:** Follow-up messages in a thread (without an `@mention`) automatically route to whichever agent last responded in that thread.
- **Isolated sessions:** Each agent gets its own Claude session per thread (`threadId:agentName`), so `@pm` and `@engineer` maintain separate conversation histories.

### Automatic agent handoffs

When an agent's response contains an `@mention` of another agent in the same project, the gateway automatically forwards that response as the next agent's input. This creates a collaborative loop:

1. User writes `@pm add a search feature to the dashboard`
2. PM agent analyzes the request, responds with requirements mentioning `@engineer`
3. Gateway automatically sends PM's response to the engineer agent
4. Engineer implements and responds mentioning `@pm` for review
5. Loop continues until no `@mention` is found or the turn limit is reached

The turn counter resets whenever a human posts a new message. The `maxTurnsPerAgent` default (5) prevents runaway loops.

### Listing agents

Use `!agents` in any mapped Discord channel to see the available agents for that project.

### Thread history

When an agent is invoked in a thread, the gateway prepends the last 20 messages as context so the agent understands the conversation so far. This is especially useful when a different agent picks up a thread mid-conversation.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `MPG_HOME` | No | Override config home directory (default: `~/.mpg`) |

### Resuming sessions from terminal

Each Claude session started by the gateway can be resumed interactively. Use `!session <name>` in Discord to get the session ID, then:

```bash
cd /path/to/project          # must match the project directory in config.json
claude --resume <session-id>
```

**Important:** You must run `claude --resume` from the same directory the session was started in (i.e., the project's `directory` in `config.json`). Claude will not find the session if you run it from a different working directory.

### Session persistence (tmux)

By default, Claude sessions run as direct child processes and are lost when the gateway stops. With tmux persistence enabled, sessions run inside detached tmux sessions and survive Ctrl+C, crashes, and gateway restarts.

**Prerequisites:** tmux must be installed (`apt install tmux` / `brew install tmux`).

**Enable it** by adding `"persistence": "tmux"` to your config defaults (or per-project):

```json
{
  "defaults": {
    "persistence": "tmux"
  }
}
```

**How recovery works:** When the gateway restarts, it auto-discovers orphaned tmux sessions from the previous run, waits for any still-running sessions to complete, and delivers their results to the originating Discord thread with a "Resumed after gateway restart" prefix.

**Known limitation:** Recovered sessions don't appear as "processing" in the web dashboard and don't trigger Discord's "typing..." indicator during recovery. See [#137](https://github.com/yama-kei/multi-project-gateway/issues/137).

## Threading and per-thread sessions

When a user posts a message in a mapped channel, the bot automatically creates a Discord thread and replies there instead of cluttering the main channel. Follow-up messages within the thread continue the same conversation.

Each thread gets its **own Claude session**, isolated from the main channel and other threads. This means:

- Multiple users can work in the same project channel without their conversations interleaving
- Each thread maintains its own context and history
- The thread inherits the project config (directory, Claude args) from the parent channel
- Threads auto-archive after 60 minutes of inactivity

If thread creation fails (e.g., due to permissions), the bot falls back to replying in the main channel.

## Discord commands

The gateway responds to commands in any mapped Discord channel:

| Command | Description |
|---------|-------------|
| `!sessions` | List all active sessions with idle time and queue depth |
| `!session <name>` | Inspect a specific project's session (ID, idle time, queue) |
| `!restart <name>` | Reset a session (fresh context, keeps worktree) |
| `!kill <name>` | Force-close a project's session |
| `!ask <agent> <message>` | Dispatch a message to a specific agent (shorthand: `!<agent> <message>`) |
| `!agents` | List available agents for the current project |
| `!help` | Show available commands |

## Web dashboard

The gateway includes a built-in web dashboard for monitoring sessions and projects. It starts automatically on the port configured by `defaults.httpPort` (default: `3100`). Set `httpPort` to `false` to disable it.

Open `http://localhost:3100/` to view the dashboard, which shows:

- Gateway health and Discord connection status
- Active sessions with last activity time and queue depth
- Configured projects and their agents

### API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web dashboard (auto-refreshes every 5 seconds) |
| `GET /health` | Health check — returns status, uptime, session/queue counts, and Discord connection state |
| `GET /api/sessions` | List all active sessions with details |
| `GET /api/projects` | List configured projects and their agents |
| `GET /api/status` | Combined status: version, health, sessions, and projects |

## Architecture

For detailed architecture documentation — message lifecycle, session management, agent dispatch, security boundaries, and extension points — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Module | Responsibility |
|--------|---------------|
| `src/cli.ts` | CLI entry point — `mpg start`, `mpg init`, `mpg status` |
| `src/resolve-home.ts` | Resolves `~/.mpg/` config home, profiles, and file resolution order |
| `src/init.ts` | Interactive setup wizard (supports `--profile`) |
| `src/config.ts` | Validates and merges `config.json` with defaults |
| `src/router.ts` | Maps channel IDs to project configs; threads resolve to their own session using the parent channel's project config |
| `src/session-manager.ts` | One session per channel/thread, queues concurrent messages, manages idle timeouts |
| `src/session-store.ts` | Persists session IDs to `.sessions.json` for resume across restarts |
| `src/claude-cli.ts` | Spawns `claude --print` subprocess, parses JSON output |
| `src/tmux.ts` | Low-level tmux helpers: create, list, kill sessions; ensures tmux is installed |
| `src/runtimes/tmux-runtime.ts` | Tmux-based agent runtime — runs Claude in detached tmux sessions for persistence across restarts |
| `src/agent-dispatch.ts` | Parses `@mentions`, resolves agent targets |
| `src/turn-counter.ts` | Tracks handoff turns per thread, enforces `maxTurnsPerAgent` |
| `src/worktree.ts` | Manages git worktrees for session isolation; reconciles orphans on startup |
| `src/embed-format.ts` | Builds Discord embeds for agent responses and handoff announcements |
| `src/persona-presets.ts` | Built-in persona library (PM, engineer, etc.) for agent shorthand config |
| `src/role-check.ts` | Checks Discord member roles against `allowedRoles` |
| `src/rate-limiter.ts` | Per-user rate limiting (sliding window) |
| `src/dashboard-server.ts` | Web dashboard and REST API (`/health`, `/api/sessions`, `/api/projects`, `/api/status`) |
| `src/logger.ts` | Structured logger with level filtering and JSON output |
| `src/discord.ts` | Discord.js client, message routing, agent handoff loop, response chunking |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run with tsx (no build step) |
| `npm run build` | Bundle with tsup to `dist/` |
| `npm start` | Run bundled CLI |
| `npm test` | Run tests once |
| `npm run test:watch` | Run tests in watch mode |

## Limitations

- **Text only** — attachments and embeds are not forwarded to Claude
- **One message at a time per project** — concurrent messages to the same project are queued
- **Per-thread sessions** — each thread gets its own Claude session scoped to the parent channel's project; threads auto-archive after 60 minutes of inactivity
- **Local only** — the gateway runs on the same machine as the project directories
- **Optional Discord access control** — per-project `allowedRoles` restricts usage to specific Discord roles; `rateLimitPerUser` throttles per-user message rate. Without these, any user in a mapped channel can send prompts

## Background reading

- [From tmux to Discord: Building a Multi-Project Gateway for Claude Code](https://yamakei.info/essays/from-tmux-to-discord-building-a-multi-project-gateway-for-claude-code) — what motivated this project
- [From Message Router to Agent Team: How MPG Learned to Coordinate](https://yamakei.info/essays/from-message-router-to-agent-team-how-mpg-learned-to-coordinate) — how the architecture evolved from simple routing to multi-agent coordination

## License

MIT
