# Multi-Project Discord Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Discord gateway that routes messages from project-specific channels to separate Claude Code CLI sessions.

**Architecture:** A Node.js + TypeScript service using discord.js v14 connects to Discord with a single bot token. Incoming messages are routed by channel ID to project configs. Each project gets its own `claude --print` subprocess invocation with `--resume` for conversational continuity. A session manager tracks active session IDs and enforces idle timeouts and concurrency limits.

**Tech Stack:** Node.js, TypeScript, discord.js v14, child_process.spawn

**Spec:** `docs/superpowers/specs/2026-03-20-multi-project-gateway-design.md`

---

## File Structure

```
multi-project-gateway/
├── src/
│   ├── index.ts           # Entry point — load config, boot Discord client + session manager
│   ├── config.ts          # Load + validate config.json, export typed config
│   ├── router.ts          # Channel ID → project config lookup (incl. thread parent resolution)
│   ├── claude-cli.ts      # Wrapper: spawn claude --print, parse JSON output, return result + session_id
│   ├── session-manager.ts # Track session IDs per project, idle timeouts, concurrency, message queue
│   └── discord.ts         # Discord client setup, message listener, response chunking + sending
├── tests/
│   ├── config.test.ts
│   ├── router.test.ts
│   ├── claude-cli.test.ts
│   ├── session-manager.test.ts
│   └── discord.test.ts
├── config.json            # Channel → project mapping (user fills in real IDs)
├── .env.example           # Template for DISCORD_BOT_TOKEN
├── .gitignore
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `config.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "multi-project-gateway",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "discord.js": "^14.14.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "tsx": "^4.7.0",
    "typescript": "^5.3.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.11.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.env
```

- [ ] **Step 5: Create .env.example**

```
DISCORD_BOT_TOKEN=your-bot-token-here
```

- [ ] **Step 6: Create config.json with placeholder structure**

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
  "projects": {}
}
```

- [ ] **Step 7: Install dependencies**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npm install`
Expected: `node_modules/` created, lock file generated

- [ ] **Step 8: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet, clean exit)

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example config.json package-lock.json
git commit -m "chore: scaffold project with TypeScript, vitest, discord.js"
```

---

### Task 2: Config Loader (`config.ts`)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig, type GatewayConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads a valid config object', () => {
    const raw = {
      defaults: {
        idleTimeoutMs: 1800000,
        maxConcurrentSessions: 4,
        claudeArgs: ['--dangerously-skip-permissions', '--output-format', 'json'],
      },
      projects: {
        '123456789': {
          name: 'TestProject',
          directory: '/tmp/test-project',
        },
      },
    };
    const config = loadConfig(raw);
    expect(config.defaults.idleTimeoutMs).toBe(1800000);
    expect(config.defaults.maxConcurrentSessions).toBe(4);
    expect(config.projects['123456789'].name).toBe('TestProject');
    expect(config.projects['123456789'].directory).toBe('/tmp/test-project');
  });

  it('throws on missing projects field', () => {
    expect(() => loadConfig({ defaults: { idleTimeoutMs: 1000, maxConcurrentSessions: 4, claudeArgs: [] } } as any)).toThrow();
  });

  it('throws on missing directory in a project', () => {
    const raw = {
      defaults: { idleTimeoutMs: 1000, maxConcurrentSessions: 4, claudeArgs: [] },
      projects: { '123': { name: 'Test' } },
    };
    expect(() => loadConfig(raw as any)).toThrow();
  });

  it('applies default idleTimeoutMs when not specified', () => {
    const raw = {
      defaults: { maxConcurrentSessions: 4, claudeArgs: [] },
      projects: {
        '123': { name: 'Test', directory: '/tmp/test' },
      },
    };
    const config = loadConfig(raw as any);
    expect(config.defaults.idleTimeoutMs).toBe(1800000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`

- [ ] **Step 3: Write implementation**

```typescript
// src/config.ts
export interface ProjectConfig {
  name: string;
  directory: string;
  idleTimeoutMs?: number;
  claudeArgs?: string[];
}

export interface GatewayDefaults {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  claudeArgs: string[];
}

export interface GatewayConfig {
  defaults: GatewayDefaults;
  projects: Record<string, ProjectConfig>;
}

export function loadConfig(raw: unknown): GatewayConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be an object');
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.projects || typeof obj.projects !== 'object') {
    throw new Error('Config must have a "projects" object');
  }

  const projects = obj.projects as Record<string, unknown>;
  const validated: Record<string, ProjectConfig> = {};

  for (const [channelId, project] of Object.entries(projects)) {
    if (!project || typeof project !== 'object') {
      throw new Error(`Project for channel ${channelId} must be an object`);
    }
    const p = project as Record<string, unknown>;
    if (typeof p.directory !== 'string' || !p.directory) {
      throw new Error(`Project for channel ${channelId} must have a "directory" string`);
    }
    validated[channelId] = {
      name: typeof p.name === 'string' ? p.name : channelId,
      directory: p.directory,
      ...(p.idleTimeoutMs !== undefined && { idleTimeoutMs: Number(p.idleTimeoutMs) }),
      ...(Array.isArray(p.claudeArgs) && { claudeArgs: p.claudeArgs as string[] }),
    };
  }

  const defaults = (obj.defaults ?? {}) as Record<string, unknown>;

  return {
    defaults: {
      idleTimeoutMs: typeof defaults.idleTimeoutMs === 'number' ? defaults.idleTimeoutMs : 1800000,
      maxConcurrentSessions: typeof defaults.maxConcurrentSessions === 'number' ? defaults.maxConcurrentSessions : 4,
      claudeArgs: Array.isArray(defaults.claudeArgs) ? (defaults.claudeArgs as string[]) : ['--dangerously-skip-permissions', '--output-format', 'json'],
    },
    projects: validated,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/config.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config loader with validation"
```

---

### Task 3: Channel Router (`router.ts`)

**Files:**
- Create: `src/router.ts`
- Test: `tests/router.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/router.test.ts
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/router.js';
import type { GatewayConfig } from '../src/config.js';

const config: GatewayConfig = {
  defaults: { idleTimeoutMs: 1800000, maxConcurrentSessions: 4, claudeArgs: [] },
  projects: {
    '111': { name: 'ProjectA', directory: '/tmp/a' },
    '222': { name: 'ProjectB', directory: '/tmp/b' },
  },
};

describe('createRouter', () => {
  const router = createRouter(config);

  it('returns project config for a mapped channel', () => {
    const result = router.resolve('111');
    expect(result).toEqual({ channelId: '111', name: 'ProjectA', directory: '/tmp/a' });
  });

  it('returns null for an unmapped channel', () => {
    expect(router.resolve('999')).toBeNull();
  });

  it('resolves a thread to its parent channel', () => {
    const result = router.resolve('thread-123', '111');
    expect(result).toEqual({ channelId: '111', name: 'ProjectA', directory: '/tmp/a' });
  });

  it('returns null when thread parent is also unmapped', () => {
    expect(router.resolve('thread-456', '999')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/router.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write implementation**

```typescript
// src/router.ts
import type { GatewayConfig, ProjectConfig } from './config.js';

export interface ResolvedProject {
  channelId: string;
  name: string;
  directory: string;
}

export interface Router {
  resolve(channelId: string, parentChannelId?: string): ResolvedProject | null;
}

export function createRouter(config: GatewayConfig): Router {
  return {
    resolve(channelId: string, parentChannelId?: string): ResolvedProject | null {
      // Direct channel match
      const project = config.projects[channelId];
      if (project) {
        return { channelId, name: project.name, directory: project.directory };
      }

      // Thread: try parent channel
      if (parentChannelId) {
        const parentProject = config.projects[parentChannelId];
        if (parentProject) {
          return { channelId: parentChannelId, name: parentProject.name, directory: parentProject.directory };
        }
      }

      return null;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/router.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/router.ts tests/router.test.ts
git commit -m "feat: add channel router with thread parent resolution"
```

---

### Task 4: Claude CLI Wrapper (`claude-cli.ts`)

**Files:**
- Create: `src/claude-cli.ts`
- Test: `tests/claude-cli.test.ts`

- [ ] **Step 1: Write the failing test**

The CLI wrapper spawns real processes, so we test the output parsing logic separately and use a mock for the spawn behavior.

```typescript
// tests/claude-cli.test.ts
import { describe, it, expect, vi } from 'vitest';
import { parseClaudeJsonOutput, buildClaudeArgs } from '../src/claude-cli.js';

describe('parseClaudeJsonOutput', () => {
  it('extracts result text and session_id from JSON output', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello! I fixed the bug.',
      session_id: 'abc-123-def',
    });
    const parsed = parseClaudeJsonOutput(json);
    expect(parsed.text).toBe('Hello! I fixed the bug.');
    expect(parsed.sessionId).toBe('abc-123-def');
    expect(parsed.isError).toBe(false);
  });

  it('handles error results', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Something went wrong',
      session_id: 'abc-123-def',
    });
    const parsed = parseClaudeJsonOutput(json);
    expect(parsed.isError).toBe(true);
    expect(parsed.text).toBe('Something went wrong');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseClaudeJsonOutput('not json')).toThrow();
  });
});

describe('buildClaudeArgs', () => {
  const baseArgs = ['--dangerously-skip-permissions', '--output-format', 'json'];

  it('builds args for a new session', () => {
    const args = buildClaudeArgs(baseArgs, 'Fix the bug', undefined);
    expect(args).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      'Fix the bug',
    ]);
  });

  it('builds args with --resume for existing session', () => {
    const args = buildClaudeArgs(baseArgs, 'Now add tests', 'session-uuid-123');
    expect(args).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--resume', 'session-uuid-123',
      'Now add tests',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/claude-cli.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write implementation**

```typescript
// src/claude-cli.ts
import { spawn } from 'node:child_process';

export interface ClaudeResult {
  text: string;
  sessionId: string;
  isError: boolean;
}

export function parseClaudeJsonOutput(raw: string): ClaudeResult {
  const data = JSON.parse(raw);
  return {
    text: data.result ?? '',
    sessionId: data.session_id ?? '',
    isError: Boolean(data.is_error),
  };
}

export function buildClaudeArgs(
  baseArgs: string[],
  prompt: string,
  sessionId: string | undefined,
): string[] {
  const args = ['--print', ...baseArgs];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  args.push(prompt);
  return args;
}

export function runClaude(
  cwd: string,
  baseArgs: string[],
  prompt: string,
  sessionId: string | undefined,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs(baseArgs, prompt, sessionId);
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const result = parseClaudeJsonOutput(stdout.trim());
        resolve(result);
      } catch (err) {
        reject(new Error(`Failed to parse claude output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/claude-cli.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/claude-cli.ts tests/claude-cli.test.ts
git commit -m "feat: add Claude CLI wrapper with JSON output parsing"
```

---

### Task 5: Session Manager (`session-manager.ts`)

**Files:**
- Create: `src/session-manager.ts`
- Test: `tests/session-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/session-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionManager, type SessionManager } from '../src/session-manager.js';

// Mock runClaude
vi.mock('../src/claude-cli.js', () => ({
  runClaude: vi.fn().mockResolvedValue({
    text: 'Mock response',
    sessionId: 'mock-session-id',
    isError: false,
  }),
  parseClaudeJsonOutput: vi.fn(),
  buildClaudeArgs: vi.fn(),
}));

const defaults = {
  idleTimeoutMs: 500, // Short timeout for testing
  maxConcurrentSessions: 2,
  claudeArgs: ['--dangerously-skip-permissions', '--output-format', 'json'],
};

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = createSessionManager(defaults);
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('sends a message and returns the response', async () => {
    const result = await manager.send('project-a', '/tmp/a', 'Hello');
    expect(result.text).toBe('Mock response');
    expect(result.isError).toBe(false);
  });

  it('tracks session ID after first message', async () => {
    await manager.send('project-a', '/tmp/a', 'Hello');
    const session = manager.getSession('project-a');
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe('mock-session-id');
  });

  it('queues concurrent messages to the same project', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    // Make first call slow
    let resolveFirst: (v: any) => void;
    mockRun.mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }));
    mockRun.mockResolvedValueOnce({ text: 'Second', sessionId: 'sid-2', isError: false });

    const first = manager.send('project-a', '/tmp/a', 'First');
    const second = manager.send('project-a', '/tmp/a', 'Second');

    // First is in progress, second is queued
    expect(manager.getSession('project-a')?.queueLength).toBe(1);

    resolveFirst!({ text: 'First', sessionId: 'sid-1', isError: false });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.text).toBe('First');
    expect(r2.text).toBe('Second');
  });

  it('clears session after idle timeout', async () => {
    await manager.send('project-a', '/tmp/a', 'Hello');
    expect(manager.getSession('project-a')).toBeDefined();

    // Wait for idle timeout
    await new Promise(r => setTimeout(r, 600));
    expect(manager.getSession('project-a')).toBeUndefined();
  });

  it('retries without session ID when resume fails', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    // First call succeeds (establishes session)
    mockRun.mockResolvedValueOnce({ text: 'First', sessionId: 'sid-1', isError: false });
    await manager.send('project-a', '/tmp/a', 'Hello');
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-1');

    // Second call fails (resume failure), third call succeeds (fresh session)
    mockRun.mockRejectedValueOnce(new Error('claude exited with code 1'));
    mockRun.mockResolvedValueOnce({ text: 'Recovered', sessionId: 'sid-2', isError: false });

    const result = await manager.send('project-a', '/tmp/a', 'Try again');
    expect(result.text).toBe('Recovered');
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-2');
  });

  it('enforces global concurrency limit', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    const resolvers: Array<(v: any) => void> = [];
    mockRun.mockImplementation(() => new Promise(r => { resolvers.push(r); }));

    // maxConcurrentSessions is 2, so third project should block
    const p1 = manager.send('project-a', '/tmp/a', 'A');
    const p2 = manager.send('project-b', '/tmp/b', 'B');
    const p3 = manager.send('project-c', '/tmp/c', 'C');

    // Give event loop a tick for processes to start
    await new Promise(r => setTimeout(r, 10));

    // Only 2 resolvers should exist (third is waiting for a slot)
    expect(resolvers).toHaveLength(2);

    // Complete first, which should unblock third
    resolvers[0]({ text: 'A done', sessionId: 'sid-a', isError: false });
    await new Promise(r => setTimeout(r, 10));
    expect(resolvers).toHaveLength(3);

    // Complete remaining
    resolvers[1]({ text: 'B done', sessionId: 'sid-b', isError: false });
    resolvers[2]({ text: 'C done', sessionId: 'sid-c', isError: false });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.text).toBe('A done');
    expect(r2.text).toBe('B done');
    expect(r3.text).toBe('C done');
  });

  it('lists active sessions', async () => {
    await manager.send('project-a', '/tmp/a', 'Hello');
    await manager.send('project-b', '/tmp/b', 'Hello');
    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.projectKey)).toContain('project-a');
    expect(sessions.map(s => s.projectKey)).toContain('project-b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/session-manager.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write implementation**

```typescript
// src/session-manager.ts
import { runClaude, type ClaudeResult } from './claude-cli.js';

export interface SessionInfo {
  sessionId: string;
  projectKey: string;
  lastActivity: number;
  queueLength: number;
}

export interface SessionManager {
  send(projectKey: string, cwd: string, prompt: string): Promise<ClaudeResult>;
  getSession(projectKey: string): SessionInfo | undefined;
  listSessions(): SessionInfo[];
  shutdown(): void;
}

interface InternalSession {
  sessionId: string | undefined;
  projectKey: string;
  cwd: string;
  lastActivity: number;
  processing: boolean;
  queue: Array<{
    prompt: string;
    resolve: (result: ClaudeResult) => void;
    reject: (error: Error) => void;
  }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export function createSessionManager(defaults: {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  claudeArgs: string[];
}): SessionManager {
  const sessions = new Map<string, InternalSession>();

  // Global concurrency limiter
  let activeProcesses = 0;
  const waiters: Array<() => void> = [];

  async function acquireSlot(): Promise<void> {
    if (activeProcesses < defaults.maxConcurrentSessions) {
      activeProcesses++;
      return;
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        activeProcesses++;
        resolve();
      });
    });
  }

  function releaseSlot(): void {
    activeProcesses--;
    const next = waiters.shift();
    if (next) next();
  }

  function resetIdleTimer(session: InternalSession) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      sessions.delete(session.projectKey);
    }, defaults.idleTimeoutMs);
  }

  async function processQueue(session: InternalSession): Promise<void> {
    if (session.processing || session.queue.length === 0) return;
    session.processing = true;

    while (session.queue.length > 0) {
      const item = session.queue.shift()!;
      await acquireSlot();
      try {
        const result = await runClaude(
          session.cwd,
          defaults.claudeArgs,
          item.prompt,
          session.sessionId,
        );
        session.sessionId = result.sessionId || session.sessionId;
        session.lastActivity = Date.now();
        resetIdleTimer(session);
        item.resolve(result);
      } catch (err) {
        // On any failure when a session ID is set, retry without it (fresh session)
        if (session.sessionId) {
          session.sessionId = undefined;
          try {
            const result = await runClaude(session.cwd, defaults.claudeArgs, item.prompt, undefined);
            session.sessionId = result.sessionId || undefined;
            session.lastActivity = Date.now();
            resetIdleTimer(session);
            item.resolve(result);
          } catch (retryErr) {
            item.reject(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
          }
        } else {
          item.reject(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        releaseSlot();
      }
    }

    session.processing = false;
  }

  function getOrCreateSession(projectKey: string, cwd: string): InternalSession {
    let session = sessions.get(projectKey);
    if (!session) {
      session = {
        sessionId: undefined,
        projectKey,
        cwd,
        lastActivity: Date.now(),
        processing: false,
        queue: [],
        idleTimer: null,
      };
      sessions.set(projectKey, session);
      resetIdleTimer(session);
    }
    return session;
  }

  return {
    send(projectKey: string, cwd: string, prompt: string): Promise<ClaudeResult> {
      const session = getOrCreateSession(projectKey, cwd);
      return new Promise<ClaudeResult>((resolve, reject) => {
        session.queue.push({ prompt, resolve, reject });
        processQueue(session);
      });
    },

    getSession(projectKey: string): SessionInfo | undefined {
      const session = sessions.get(projectKey);
      if (!session) return undefined;
      return {
        sessionId: session.sessionId ?? '',
        projectKey: session.projectKey,
        lastActivity: session.lastActivity,
        queueLength: session.queue.length,
      };
    },

    listSessions(): SessionInfo[] {
      return Array.from(sessions.values()).map((s) => ({
        sessionId: s.sessionId ?? '',
        projectKey: s.projectKey,
        lastActivity: s.lastActivity,
        queueLength: s.queue.length,
      }));
    },

    shutdown() {
      for (const session of sessions.values()) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
      }
      sessions.clear();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/session-manager.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/session-manager.ts tests/session-manager.test.ts
git commit -m "feat: add session manager with queuing, idle timeout, and resume retry"
```

---

### Task 6: Discord Bot (`discord.ts`)

**Files:**
- Create: `src/discord.ts`
- Test: `tests/discord.test.ts`

- [ ] **Step 1: Write the failing test for message chunking**

The Discord module has two testable parts: message chunking (pure logic) and the bot setup (integration). Test the chunking first.

```typescript
// tests/discord.test.ts
import { describe, it, expect } from 'vitest';
import { chunkMessage } from '../src/discord.js';

describe('chunkMessage', () => {
  it('returns a single chunk for short messages', () => {
    const chunks = chunkMessage('Hello world', 2000);
    expect(chunks).toEqual(['Hello world']);
  });

  it('splits at newline boundaries', () => {
    const line = 'A'.repeat(1500);
    const msg = `${line}\n${'B'.repeat(1500)}`;
    const chunks = chunkMessage(msg, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line);
    expect(chunks[1]).toBe('B'.repeat(1500));
  });

  it('force-splits lines longer than the limit', () => {
    const msg = 'A'.repeat(4500);
    const chunks = chunkMessage(msg, 2000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2000);
    expect(chunks[1]).toHaveLength(2000);
    expect(chunks[2]).toHaveLength(500);
  });

  it('handles empty string', () => {
    expect(chunkMessage('', 2000)).toEqual(['']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/discord.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write implementation**

```typescript
// src/discord.ts
import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import type { Router } from './router.js';
import type { SessionManager } from './session-manager.js';

export function chunkMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    // If a single line exceeds the limit, force-split it
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

export interface DiscordBot {
  start(token: string): Promise<void>;
  stop(): void;
}

export function createDiscordBot(router: Router, sessionManager: SessionManager): DiscordBot {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots
    if (message.author.bot) return;

    const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
    const resolved = router.resolve(message.channelId, parentId);
    if (!resolved) return;

    // Acknowledge receipt
    try {
      await message.react('👀');
    } catch {
      // Reaction may fail if permissions are missing — non-critical
    }

    try {
      const result = await sessionManager.send(
        resolved.channelId,
        resolved.directory,
        message.content,
      );

      const chunks = chunkMessage(result.text, 2000);
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await message.channel.send(
        `**Error** (${resolved.name}): ${errorMsg.slice(0, 1800)}`,
      );
    }
  });

  return {
    async start(token: string) {
      await client.login(token);
      console.log(`Gateway connected as ${client.user?.tag}`);
    },
    stop() {
      client.destroy();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run tests/discord.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/discord.ts tests/discord.test.ts
git commit -m "feat: add Discord bot with message routing and response chunking"
```

---

### Task 7: Entry Point (`index.ts`)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write the entry point**

```typescript
// src/index.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createRouter } from './router.js';
import { createSessionManager } from './session-manager.js';
import { createDiscordBot } from './discord.js';

loadEnv();

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('DISCORD_BOT_TOKEN environment variable is required');
  process.exit(1);
}

const configPath = resolve(process.cwd(), 'config.json');
const rawConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
const config = loadConfig(rawConfig);

const projectCount = Object.keys(config.projects).length;
if (projectCount === 0) {
  console.error('No projects configured in config.json');
  process.exit(1);
}
console.log(`Loaded ${projectCount} project(s) from config`);

const router = createRouter(config);
const sessionManager = createSessionManager(config.defaults);
const bot = createDiscordBot(router, sessionManager);

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  sessionManager.shutdown();
  bot.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bot.start(token).catch((err) => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point wiring config, router, sessions, and Discord bot"
```

---

### Task 8: End-to-End Smoke Test

**Files:**
- Modify: `config.json` (add one real project for testing)

- [ ] **Step 1: Create a test channel in your Discord server**

Manually create a `#gateway-test` channel in your Discord server. Note the channel ID.

- [ ] **Step 2: Update config.json with real channel ID**

Replace `config.json` with a real project mapping. Use pm-hOS or another existing project directory as a test target:

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
    "<GATEWAY_TEST_CHANNEL_ID>": {
      "name": "gateway-test",
      "directory": "/home/yamakei/Documents/pm-hOS"
    }
  }
}
```

- [ ] **Step 3: Create .env with bot token**

```bash
cp .env.example .env
# Edit .env and add your DISCORD_BOT_TOKEN
```

- [ ] **Step 4: Run the gateway**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npm run dev`
Expected: `Loaded 1 project(s) from config` followed by `Gateway connected as <bot-name>`

- [ ] **Step 5: Send a test message in Discord**

Post in `#gateway-test`: "What files are in the root of this project?"
Expected: Bot reacts with 👀, then replies with a list of files from pm-hOS

- [ ] **Step 6: Test conversation continuity**

Post a follow-up: "What was my previous question?"
Expected: Claude references your previous message (confirming `--resume` works)

- [ ] **Step 7: Commit working config template**

```bash
git add config.json
git commit -m "docs: update config.json with tested structure"
```

---

### Task 9: Add Remaining Project Channels

**Files:**
- Modify: `config.json`

- [ ] **Step 1: Create Discord channels for each project**

Create channels in your Discord server: `#rallyhub`, `#mochi`, `#takumi`, `#intentlayer` (and any others). Note their channel IDs.

- [ ] **Step 2: Update config.json with all projects**

Add all project mappings with their real channel IDs and directories.

- [ ] **Step 3: Restart the gateway and verify**

Run: `cd /home/yamakei/Documents/multi-project-gateway && npm run dev`
Expected: `Loaded N project(s) from config` with the correct count

- [ ] **Step 4: Test a message in each channel**

Send a simple message in each project channel to verify routing works.

- [ ] **Step 5: Commit**

```bash
git add config.json
git commit -m "feat: add all project channel mappings"
```
