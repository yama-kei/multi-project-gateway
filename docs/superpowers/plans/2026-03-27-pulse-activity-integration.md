# Pulse Activity Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit session lifecycle events as JSONL for pulse to aggregate, expose activity API endpoints, and add dashboard charts.

**Architecture:** MPG writes JSONL events to `~/.pulse/events/mpg-sessions.jsonl` at session lifecycle points. API endpoints shell out to `pulse activity --json` CLI for reads. Dashboard renders Chart.js charts from API data.

**Tech Stack:** Node.js (fs, child_process), Chart.js 4 via CDN, Vitest for tests.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/pulse-events.ts` | Create | JSONL event emitter — constructs and appends session events |
| `tests/pulse-events.test.ts` | Create | Unit tests for emitter |
| `src/session-manager.ts` | Modify | Hook pulse emitter at lifecycle points, add messageCount/createdAt tracking |
| `tests/session-manager.test.ts` | Modify | Add pulse emission tests |
| `src/health-server.ts` | Modify | Add `/api/activity/*` endpoints + Activity tab in dashboard |
| `tests/health-server.test.ts` | Modify | Add activity endpoint tests |
| `src/cli.ts` | Modify | Wire up `createPulseEmitter()` and pass to session manager |

---

### Task 1: Pulse Event Emitter Module

**Files:**
- Create: `src/pulse-events.ts`
- Create: `tests/pulse-events.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/pulse-events.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPulseEmitter } from '../src/pulse-events.js';

describe('PulseEmitter', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pulse-test-'));
    filePath = join(dir, 'events', 'mpg-sessions.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits session_start event with correct schema', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionStart('sess-1', 'project-a', '/tmp/project', { agentName: 'engineer', triggerSource: 'discord' });

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.schema_version).toBe(1);
    expect(event.event_type).toBe('session_start');
    expect(event.session_id).toBe('sess-1');
    expect(event.project_key).toBe('project-a');
    expect(event.project_dir).toBe('/tmp/project');
    expect(event.agent_name).toBe('engineer');
    expect(event.trigger_source).toBe('discord');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('emits session_end event', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionEnd('sess-1', 'project-a', '/tmp/project', 60000, 5);

    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(event.event_type).toBe('session_end');
    expect(event.duration_ms).toBe(60000);
    expect(event.message_count).toBe(5);
  });

  it('emits session_idle event', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionIdle('sess-1', 'project-a', '/tmp/project', 30000, 3);

    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(event.event_type).toBe('session_idle');
    expect(event.duration_ms).toBe(30000);
    expect(event.message_count).toBe(3);
  });

  it('emits session_resume event', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionResume('sess-1', 'project-a', '/tmp/project', 120000);

    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(event.event_type).toBe('session_resume');
    expect(event.idle_duration_ms).toBe(120000);
  });

  it('emits message_routed event', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.messageRouted('sess-1', 'project-a', '/tmp/project', { agentTarget: 'pm', queueDepth: 2 });

    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(event.event_type).toBe('message_routed');
    expect(event.agent_target).toBe('pm');
    expect(event.queue_depth).toBe(2);
  });

  it('appends multiple events to same file', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionStart('sess-1', 'project-a', '/tmp/project', { triggerSource: 'discord' });
    emitter.messageRouted('sess-1', 'project-a', '/tmp/project', { queueDepth: 0 });

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event_type).toBe('session_start');
    expect(JSON.parse(lines[1]).event_type).toBe('message_routed');
  });

  it('creates parent directories if they do not exist', () => {
    const deepPath = join(dir, 'a', 'b', 'c', 'events.jsonl');
    const emitter = createPulseEmitter(deepPath);
    emitter.sessionStart('sess-1', 'project-a', '/tmp/project', { triggerSource: 'discord' });

    const content = readFileSync(deepPath, 'utf-8').trim();
    expect(JSON.parse(content).event_type).toBe('session_start');
  });

  it('does not throw on write failure (fire-and-forget)', () => {
    const emitter = createPulseEmitter('/dev/null/impossible/path.jsonl');
    expect(() => {
      emitter.sessionStart('sess-1', 'project-a', '/tmp/project', { triggerSource: 'discord' });
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pulse-events.test.ts`
Expected: FAIL — cannot resolve `../src/pulse-events.js`

- [ ] **Step 3: Implement the emitter**

Create `src/pulse-events.ts`:

```typescript
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface PulseEmitter {
  sessionStart(sessionId: string, projectKey: string, projectDir: string, opts?: { agentName?: string; triggerSource?: string }): void;
  sessionEnd(sessionId: string, projectKey: string, projectDir: string, durationMs: number, messageCount: number): void;
  sessionIdle(sessionId: string, projectKey: string, projectDir: string, durationMs: number, messageCount: number): void;
  sessionResume(sessionId: string, projectKey: string, projectDir: string, idleDurationMs: number): void;
  messageRouted(sessionId: string, projectKey: string, projectDir: string, opts?: { agentTarget?: string; queueDepth?: number }): void;
}

const DEFAULT_PATH = join(homedir(), '.pulse', 'events', 'mpg-sessions.jsonl');

function baseEvent(eventType: string, sessionId: string, projectKey: string, projectDir: string) {
  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    event_type: eventType,
    session_id: sessionId,
    project_key: projectKey,
    project_dir: projectDir,
  };
}

export function createPulseEmitter(filePath?: string): PulseEmitter {
  const target = filePath ?? DEFAULT_PATH;
  let dirCreated = false;

  function emit(event: Record<string, unknown>): void {
    try {
      if (!dirCreated) {
        mkdirSync(dirname(target), { recursive: true });
        dirCreated = true;
      }
      appendFileSync(target, JSON.stringify(event) + '\n');
    } catch {
      // Fire-and-forget: never crash the gateway for event logging
    }
  }

  return {
    sessionStart(sessionId, projectKey, projectDir, opts) {
      emit({
        ...baseEvent('session_start', sessionId, projectKey, projectDir),
        agent_name: opts?.agentName,
        trigger_source: opts?.triggerSource ?? 'unknown',
      });
    },

    sessionEnd(sessionId, projectKey, projectDir, durationMs, messageCount) {
      emit({
        ...baseEvent('session_end', sessionId, projectKey, projectDir),
        duration_ms: durationMs,
        message_count: messageCount,
      });
    },

    sessionIdle(sessionId, projectKey, projectDir, durationMs, messageCount) {
      emit({
        ...baseEvent('session_idle', sessionId, projectKey, projectDir),
        duration_ms: durationMs,
        message_count: messageCount,
      });
    },

    sessionResume(sessionId, projectKey, projectDir, idleDurationMs) {
      emit({
        ...baseEvent('session_resume', sessionId, projectKey, projectDir),
        idle_duration_ms: idleDurationMs,
      });
    },

    messageRouted(sessionId, projectKey, projectDir, opts) {
      emit({
        ...baseEvent('message_routed', sessionId, projectKey, projectDir),
        agent_target: opts?.agentTarget,
        queue_depth: opts?.queueDepth ?? 0,
      });
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pulse-events.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/pulse-events.ts tests/pulse-events.test.ts
git commit -m "feat(#64): add pulse event emitter module"
```

---

### Task 2: Hook Emitter into Session Manager

**Files:**
- Modify: `src/session-manager.ts`
- Modify: `tests/session-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the end of `tests/session-manager.test.ts`, inside the existing `describe('SessionManager', ...)` block:

```typescript
  describe('pulse event emission', () => {
    let pulseEmitter: {
      sessionStart: ReturnType<typeof vi.fn>;
      sessionEnd: ReturnType<typeof vi.fn>;
      sessionIdle: ReturnType<typeof vi.fn>;
      sessionResume: ReturnType<typeof vi.fn>;
      messageRouted: ReturnType<typeof vi.fn>;
    };
    let pulseManager: SessionManager;

    beforeEach(async () => {
      const { runClaude } = await import('../src/claude-cli.js');
      vi.mocked(runClaude).mockReset();
      vi.mocked(runClaude).mockResolvedValue({
        text: 'Mock response',
        sessionId: 'mock-session-id',
        isError: false,
      });

      pulseEmitter = {
        sessionStart: vi.fn(),
        sessionEnd: vi.fn(),
        sessionIdle: vi.fn(),
        sessionResume: vi.fn(),
        messageRouted: vi.fn(),
      };
      pulseManager = createSessionManager(defaults, undefined, pulseEmitter);
    });

    afterEach(() => {
      pulseManager.shutdown();
    });

    it('emits session_start on first message to a project', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.sessionStart).toHaveBeenCalledOnce();
      expect(pulseEmitter.sessionStart).toHaveBeenCalledWith(
        expect.any(String), 'project-a', '/tmp/a', expect.objectContaining({ triggerSource: 'discord' }),
      );
    });

    it('emits message_routed on each dispatched message', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.messageRouted).toHaveBeenCalledOnce();
      expect(pulseEmitter.messageRouted).toHaveBeenCalledWith(
        expect.any(String), 'project-a', '/tmp/a', expect.objectContaining({ queueDepth: expect.any(Number) }),
      );
    });

    it('does not emit session_start on subsequent messages to same project', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      await pulseManager.send('project-a', '/tmp/a', 'World');
      expect(pulseEmitter.sessionStart).toHaveBeenCalledOnce();
      expect(pulseEmitter.messageRouted).toHaveBeenCalledTimes(2);
    });

    it('emits session_end on clearSession', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      pulseManager.clearSession('project-a');
      expect(pulseEmitter.sessionEnd).toHaveBeenCalledOnce();
      expect(pulseEmitter.sessionEnd).toHaveBeenCalledWith(
        'mock-session-id', 'project-a', '/tmp/a', expect.any(Number), 1,
      );
    });

    it('emits session_idle when idle timer fires', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      // Wait for idle timeout (500ms in test defaults)
      await new Promise(r => setTimeout(r, 600));
      expect(pulseEmitter.sessionIdle).toHaveBeenCalledOnce();
      expect(pulseEmitter.sessionIdle).toHaveBeenCalledWith(
        'mock-session-id', 'project-a', '/tmp/a', expect.any(Number), 1,
      );
    });

    it('emits session_resume when restoring a persisted session', async () => {
      const store = createMockStore([{
        sessionId: 'old-session',
        projectKey: 'project-a',
        cwd: '/tmp/a',
        lastActivity: Date.now() - 60000,
      }]);
      const resumeManager = createSessionManager(defaults, store, pulseEmitter);
      await resumeManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.sessionResume).toHaveBeenCalledOnce();
      expect(pulseEmitter.sessionResume).toHaveBeenCalledWith(
        'old-session', 'project-a', '/tmp/a', expect.any(Number),
      );
      // Should NOT emit session_start for restored sessions
      expect(pulseEmitter.sessionStart).not.toHaveBeenCalled();
      resumeManager.shutdown();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: FAIL — `createSessionManager` doesn't accept a third argument

- [ ] **Step 3: Modify session-manager.ts to accept and use pulse emitter**

In `src/session-manager.ts`, make the following changes:

**Import the PulseEmitter type** at the top:

```typescript
import type { PulseEmitter } from './pulse-events.js';
```

**Add the `pulseEmitter` parameter** to `createSessionManager`:

Change the function signature from:
```typescript
export function createSessionManager(defaults: {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  sessionTtlMs?: number;
  maxPersistedSessions?: number;
  claudeArgs: string[];
}, store?: SessionStore): SessionManager {
```
To:
```typescript
export function createSessionManager(defaults: {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  sessionTtlMs?: number;
  maxPersistedSessions?: number;
  claudeArgs: string[];
}, store?: SessionStore, pulseEmitter?: PulseEmitter): SessionManager {
```

**Add `messageCount` and `createdAt` to `InternalSession`**:

Change:
```typescript
interface InternalSession {
  sessionId: string | undefined;
  projectKey: string;
  cwd: string;
  projectDir: string | undefined;
  worktreePath: string | undefined;
  lastActivity: number;
  processing: boolean;
  queue: Array<{
```
To:
```typescript
interface InternalSession {
  sessionId: string | undefined;
  projectKey: string;
  cwd: string;
  projectDir: string | undefined;
  worktreePath: string | undefined;
  lastActivity: number;
  createdAt: number;
  messageCount: number;
  restored: boolean;
  processing: boolean;
  queue: Array<{
```

**Emit `session_idle` in the idle timer callback** inside `resetIdleTimer`:

Change:
```typescript
  function resetIdleTimer(session: InternalSession) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    // Don't start idle timer while session has queued work waiting.
    if (session.queue.length > 0) return;
    session.idleTimer = setTimeout(() => {
      // Remove from memory only; session ID and worktree stay on disk for later resume.
      // Worktrees persist on idle intentionally — cleaned up on !kill or startup reconciliation.
      sessions.delete(session.projectKey);
    }, defaults.idleTimeoutMs);
  }
```
To:
```typescript
  function resetIdleTimer(session: InternalSession) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.queue.length > 0) return;
    session.idleTimer = setTimeout(() => {
      if (pulseEmitter && session.sessionId) {
        pulseEmitter.sessionIdle(
          session.sessionId,
          session.projectKey,
          session.cwd,
          Date.now() - session.createdAt,
          session.messageCount,
        );
      }
      sessions.delete(session.projectKey);
    }, defaults.idleTimeoutMs);
  }
```

**Emit `message_routed` in `processQueue`** just before `runClaude` (inside the while loop, after `acquireSlot`):

Add right after `await acquireSlot();` (line 138):

```typescript
      if (pulseEmitter) {
        pulseEmitter.messageRouted(
          session.sessionId ?? session.projectKey,
          session.projectKey,
          session.cwd,
          { agentTarget: undefined, queueDepth: session.queue.length },
        );
      }
```

**Increment `messageCount`** after successful `runClaude`, right after `session.lastActivity = Date.now();`:

```typescript
        session.messageCount++;
```

Also add the same `session.messageCount++;` after the retry success path (after `session.lastActivity = Date.now();` in the retry block).

**Emit `session_start` or `session_resume` in `getOrCreateSession`**:

At the end of `getOrCreateSession`, just before `return session;` (when a new session is created, inside the `if (!session)` block), after `sessions.set(projectKey, session)` and `resetIdleTimer(session)`:

```typescript
      if (pulseEmitter) {
        if (restoredSessionId) {
          pulseEmitter.sessionResume(
            restoredSessionId,
            projectKey,
            effectiveCwd,
            Date.now() - (store?.load().get(projectKey)?.lastActivity ?? Date.now()),
          );
        } else {
          pulseEmitter.sessionStart(
            session.sessionId ?? projectKey,
            projectKey,
            effectiveCwd,
            { triggerSource: 'discord' },
          );
        }
      }
```

**Initialize new fields in session creation** (in `getOrCreateSession`):

Change the session object literal from:
```typescript
      session = {
        sessionId: restoredSessionId,
        projectKey,
        cwd: effectiveCwd,
        projectDir,
        worktreePath,
        lastActivity: Date.now(),
        processing: false,
        queue: [],
        idleTimer: null,
      };
```
To:
```typescript
      session = {
        sessionId: restoredSessionId,
        projectKey,
        cwd: effectiveCwd,
        projectDir,
        worktreePath,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        messageCount: 0,
        restored: !!restoredSessionId,
        processing: false,
        queue: [],
        idleTimer: null,
      };
```

**Also add the new fields to the startup restoration loop** (around line 239):

Change:
```typescript
      sessions.set(key, {
        sessionId: entry.sessionId,
        projectKey: entry.projectKey,
        cwd: entry.cwd,
        projectDir: entry.projectDir,
        worktreePath: entry.worktreePath,
        lastActivity: entry.lastActivity,
        processing: false,
        queue: [],
        idleTimer: null,
      });
```
To:
```typescript
      sessions.set(key, {
        sessionId: entry.sessionId,
        projectKey: entry.projectKey,
        cwd: entry.cwd,
        projectDir: entry.projectDir,
        worktreePath: entry.worktreePath,
        lastActivity: entry.lastActivity,
        createdAt: entry.lastActivity,
        messageCount: 0,
        restored: true,
        processing: false,
        queue: [],
        idleTimer: null,
      });
```

**Emit `session_end` in `clearSession`**:

Change:
```typescript
    clearSession(projectKey: string): boolean {
      const session = sessions.get(projectKey);
      if (!session) return false;
      if (session.idleTimer) clearTimeout(session.idleTimer);
      if (session.worktreePath && session.projectDir) {
        gitRemoveWorktree(session.projectDir, session.projectKey);
      }
      sessions.delete(projectKey);
      persistSessions();
      return true;
    },
```
To:
```typescript
    clearSession(projectKey: string): boolean {
      const session = sessions.get(projectKey);
      if (!session) return false;
      if (session.idleTimer) clearTimeout(session.idleTimer);
      if (pulseEmitter && session.sessionId) {
        pulseEmitter.sessionEnd(
          session.sessionId,
          session.projectKey,
          session.cwd,
          Date.now() - session.createdAt,
          session.messageCount,
        );
      }
      if (session.worktreePath && session.projectDir) {
        gitRemoveWorktree(session.projectDir, session.projectKey);
      }
      sessions.delete(projectKey);
      persistSessions();
      return true;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: All tests PASS (both existing and new pulse tests)

- [ ] **Step 5: Commit**

```bash
git add src/session-manager.ts tests/session-manager.test.ts
git commit -m "feat(#64): hook pulse emitter into session lifecycle"
```

---

### Task 3: Activity API Endpoints

**Files:**
- Modify: `src/health-server.ts`
- Modify: `tests/health-server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the end of `tests/health-server.test.ts`, inside the existing `describe('createHealthServer', ...)` block:

```typescript
  describe('activity endpoints', () => {
    it('GET /api/activity/sessions returns pulse CLI output', async () => {
      const port = getPort();
      const mockPulseOutput = JSON.stringify({
        source: 'mpg-sessions',
        filters: {},
        events: [{ event_type: 'session_start', session_id: 'abc' }],
      });
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        runPulseCli: async () => mockPulseOutput,
      });
      const res = await httpGet(port, '/api/activity/sessions?range=7d');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.events).toHaveLength(1);
      expect(body.pulse_available).toBe(true);
    });

    it('GET /api/activity/summary returns pulse CLI output', async () => {
      const port = getPort();
      const mockPulseOutput = JSON.stringify({
        source: 'mpg-sessions',
        filters: {},
        bucket: 'day',
        sessions_per_bucket: [],
        duration_stats: [],
        message_volume: [],
        persona_breakdown: [],
        peak_concurrent: [],
      });
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        runPulseCli: async () => mockPulseOutput,
      });
      const res = await httpGet(port, '/api/activity/summary?range=7d&bucket=day');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.pulse_available).toBe(true);
      expect(body.bucket).toBe('day');
    });

    it('GET /api/activity/sessions returns empty data when pulse unavailable', async () => {
      const port = getPort();
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        runPulseCli: async () => { throw new Error('pulse not found'); },
      });
      const res = await httpGet(port, '/api/activity/sessions');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.pulse_available).toBe(false);
      expect(body.events).toEqual([]);
    });

    it('GET /api/activity/summary returns empty data when pulse unavailable', async () => {
      const port = getPort();
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        runPulseCli: async () => { throw new Error('pulse not found'); },
      });
      const res = await httpGet(port, '/api/activity/summary');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.pulse_available).toBe(false);
      expect(body.sessions_per_bucket).toEqual([]);
    });

    it('forwards query params as CLI flags', async () => {
      const port = getPort();
      const calls: string[][] = [];
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        runPulseCli: async (args) => {
          calls.push(args);
          return JSON.stringify({ source: 'mpg-sessions', filters: {}, events: [] });
        },
      });
      await httpGet(port, '/api/activity/sessions?range=24h&project=my-proj&type=session_start');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('--range');
      expect(calls[0]).toContain('24h');
      expect(calls[0]).toContain('--project');
      expect(calls[0]).toContain('my-proj');
      expect(calls[0]).toContain('--type');
      expect(calls[0]).toContain('session_start');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/health-server.test.ts`
Expected: FAIL — `createHealthServer` doesn't accept a 5th argument

- [ ] **Step 3: Add activity endpoints and pulse CLI runner to health-server.ts**

In `src/health-server.ts`, make the following changes:

**Add import** at top:

```typescript
import { execFile } from 'node:child_process';
```

**Add options interface and default pulse runner** after the `getVersion()` function:

```typescript
export interface HealthServerOptions {
  runPulseCli?: (args: string[]) => Promise<string>;
}

function defaultRunPulseCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('pulse', ['activity', ...args], { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}
```

**Update `createHealthServer` signature** from:

```typescript
export function createHealthServer(
  port: number,
  sessionManager: SessionManager,
  bot: DiscordBot,
  config?: GatewayConfig,
): Promise<HealthServer> {
```
To:
```typescript
export function createHealthServer(
  port: number,
  sessionManager: SessionManager,
  bot: DiscordBot,
  config?: GatewayConfig,
  options?: HealthServerOptions,
): Promise<HealthServer> {
```

**Add pulse runner** at the start of `createHealthServer`, after `const dashboardHtml = buildDashboardHtml();`:

```typescript
  const runPulse = options?.runPulseCli ?? defaultRunPulseCli;
```

**Add the two activity endpoint handlers** in the request handler, before the `pathname === '/'` check:

```typescript
    if (pathname === '/api/activity/sessions') {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const args: string[] = ['sessions', '--json'];
      const range = url.searchParams.get('range');
      if (range) { args.push('--range', range); }
      const project = url.searchParams.get('project');
      if (project) { args.push('--project', project); }
      const type = url.searchParams.get('type');
      if (type) { args.push('--type', type); }

      runPulse(args)
        .then((stdout) => {
          const data = JSON.parse(stdout);
          data.pulse_available = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        })
        .catch(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            source: 'mpg-sessions', filters: {}, events: [], pulse_available: false,
          }));
        });
      return;
    }

    if (pathname === '/api/activity/summary') {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const args: string[] = ['summary', '--json'];
      const range = url.searchParams.get('range');
      if (range) { args.push('--range', range); }
      const project = url.searchParams.get('project');
      if (project) { args.push('--project', project); }
      const bucket = url.searchParams.get('bucket');
      if (bucket) { args.push('--bucket', bucket); }

      runPulse(args)
        .then((stdout) => {
          const data = JSON.parse(stdout);
          data.pulse_available = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        })
        .catch(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            source: 'mpg-sessions', filters: {}, bucket: 'day',
            sessions_per_bucket: [], duration_stats: [], message_volume: [],
            persona_breakdown: [], peak_concurrent: [], pulse_available: false,
          }));
        });
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/health-server.test.ts`
Expected: All tests PASS (existing + new activity endpoint tests)

- [ ] **Step 5: Commit**

```bash
git add src/health-server.ts tests/health-server.test.ts
git commit -m "feat(#64): add /api/activity/* endpoints with pulse CLI proxy"
```

---

### Task 4: Wire Up Emitter in CLI

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add import**

Add to the imports at the top of `src/cli.ts`:

```typescript
import { createPulseEmitter } from './pulse-events.js';
```

- [ ] **Step 2: Create emitter and pass to session manager**

In the `start()` function, change:

```typescript
  const sessionManager = createSessionManager(config.defaults, sessionStore);
```
To:
```typescript
  const pulseEmitter = createPulseEmitter();
  const sessionManager = createSessionManager(config.defaults, sessionStore, pulseEmitter);
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(#64): wire pulse emitter into CLI startup"
```

---

### Task 5: Dashboard Activity Tab

**Files:**
- Modify: `src/health-server.ts` (the `buildDashboardHtml()` function)

- [ ] **Step 1: Add Chart.js CDN and tab navigation to dashboard HTML**

In `src/health-server.ts`, modify `buildDashboardHtml()`. Replace the entire function with the updated version that adds:

1. Chart.js CDN script tag in `<head>`:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
```

2. Tab navigation after the `<h1>` and subtitle:
```html
<div class="tabs">
  <button class="tab active" onclick="switchTab('overview')">Overview</button>
  <button class="tab" onclick="switchTab('activity')">Activity</button>
</div>
```

3. Wrap existing dashboard content in `<div id="tab-overview">...</div>`

4. Add new Activity tab content:
```html
<div id="tab-activity" style="display:none">
  <div class="range-selector">
    <button class="range-btn active" data-range="24h">24h</button>
    <button class="range-btn" data-range="7d">7d</button>
    <button class="range-btn" data-range="30d">30d</button>
  </div>
  <div class="chart-grid">
    <div class="chart-card">
      <h3>Sessions Over Time</h3>
      <canvas id="sessions-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Message Volume</h3>
      <canvas id="messages-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Persona Breakdown</h3>
      <canvas id="persona-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Peak Concurrency</h3>
      <canvas id="concurrency-chart"></canvas>
    </div>
  </div>
  <h3>Duration Stats</h3>
  <div id="duration-table"></div>
  <div id="pulse-warning" class="empty" style="display:none">Pulse CLI not available — install pulse for activity graphs</div>
</div>
```

5. Tab CSS:
```css
.tabs { display: flex; gap: 8px; margin-bottom: 24px; }
.tab { background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #8b949e; padding: 8px 16px; cursor: pointer; font-size: 14px; }
.tab.active { color: #e1e4e8; border-color: #58a6ff; background: #1c2333; }
.range-selector { display: flex; gap: 8px; margin-bottom: 16px; }
.range-btn { background: #161b22; border: 1px solid #30363d; border-radius: 4px; color: #8b949e; padding: 6px 12px; cursor: pointer; font-size: 13px; }
.range-btn.active { color: #e1e4e8; border-color: #58a6ff; }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 16px; margin-bottom: 24px; }
.chart-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
.chart-card h3 { font-size: 14px; color: #8b949e; margin-bottom: 12px; }
```

6. Activity JavaScript (add after existing `refresh()` and `setInterval` calls):

```javascript
var chartInstances = {};
var currentRange = '7d';
var CHART_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#79c0ff'];

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelector('[onclick="switchTab(\\''+tab+'\\')"]').classList.add('active');
  document.getElementById('tab-overview').style.display = tab === 'overview' ? '' : 'none';
  document.getElementById('tab-activity').style.display = tab === 'activity' ? '' : 'none';
  if (tab === 'activity') refreshActivity();
}

document.querySelectorAll('.range-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.range-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    refreshActivity();
  });
});

function destroyChart(key) {
  if (chartInstances[key]) { chartInstances[key].destroy(); chartInstances[key] = null; }
}

function chartDefaults() {
  return {
    color: '#8b949e',
    borderColor: '#30363d',
    backgroundColor: 'transparent',
  };
}

function refreshActivity() {
  fetch('/api/activity/summary?range=' + currentRange + '&bucket=' + (currentRange === '24h' ? 'hour' : 'day'))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.pulse_available === false) {
        document.getElementById('pulse-warning').style.display = '';
        return;
      }
      document.getElementById('pulse-warning').style.display = 'none';

      // Sessions Over Time
      var sessionBuckets = {};
      d.sessions_per_bucket.forEach(function(s) {
        if (!sessionBuckets[s.bucket]) sessionBuckets[s.bucket] = 0;
        sessionBuckets[s.bucket] += s.count;
      });
      var sLabels = Object.keys(sessionBuckets).sort();
      var sData = sLabels.map(function(l) { return sessionBuckets[l]; });
      destroyChart('sessions');
      chartInstances['sessions'] = new Chart(document.getElementById('sessions-chart'), {
        type: 'bar',
        data: { labels: sLabels, datasets: [{ label: 'Sessions', data: sData, backgroundColor: '#58a6ff' }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } }
      });

      // Message Volume
      var msgBuckets = {};
      d.message_volume.forEach(function(m) {
        if (!msgBuckets[m.bucket]) msgBuckets[m.bucket] = 0;
        msgBuckets[m.bucket] += m.count;
      });
      var mLabels = Object.keys(msgBuckets).sort();
      var mData = mLabels.map(function(l) { return msgBuckets[l]; });
      destroyChart('messages');
      chartInstances['messages'] = new Chart(document.getElementById('messages-chart'), {
        type: 'line',
        data: { labels: mLabels, datasets: [{ label: 'Messages', data: mData, borderColor: '#3fb950', tension: 0.3 }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } }
      });

      // Persona Breakdown
      var pLabels = d.persona_breakdown.map(function(p) { return p.agent || 'default'; });
      var pData = d.persona_breakdown.map(function(p) { return p.count; });
      destroyChart('persona');
      chartInstances['persona'] = new Chart(document.getElementById('persona-chart'), {
        type: 'doughnut',
        data: { labels: pLabels, datasets: [{ data: pData, backgroundColor: CHART_COLORS.slice(0, pLabels.length) }] },
        options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Peak Concurrency
      var cLabels = d.peak_concurrent.map(function(p) { return p.bucket; });
      var cData = d.peak_concurrent.map(function(p) { return p.max_concurrent; });
      destroyChart('concurrency');
      chartInstances['concurrency'] = new Chart(document.getElementById('concurrency-chart'), {
        type: 'line',
        data: { labels: cLabels, datasets: [{ label: 'Peak Concurrent', data: cData, borderColor: '#d29922', tension: 0.3 }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#30363d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } }
      });

      // Duration Stats Table
      var dt = document.getElementById('duration-table');
      if (d.duration_stats.length === 0) {
        dt.innerHTML = '<div class="empty">No duration data</div>';
      } else {
        var h = '<table><tr><th>Project</th><th>Avg</th><th>Median</th><th>P95</th></tr>';
        d.duration_stats.forEach(function(s) {
          h += '<tr><td>' + escapeHtml(s.project_key) + '</td><td>' + (s.avg_ms / 60000).toFixed(1) + 'm</td><td>' + (s.median_ms / 60000).toFixed(1) + 'm</td><td>' + (s.p95_ms / 60000).toFixed(1) + 'm</td></tr>';
        });
        h += '</table>';
        dt.innerHTML = h;
      }
    })
    .catch(function() {
      document.getElementById('pulse-warning').style.display = '';
    });
}

setInterval(function() {
  if (document.getElementById('tab-activity').style.display !== 'none') {
    refreshActivity();
  }
}, 30000);
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (dashboard HTML is a string — no test breakage)

- [ ] **Step 3: Commit**

```bash
git add src/health-server.ts
git commit -m "feat(#64): add Activity tab with Chart.js graphs to dashboard"
```

---

### Task 6: Final Verification and Build

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run build**

Run: `npx tsup`
Expected: Build completes with no errors

- [ ] **Step 3: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit any fixes if needed, then create PR**

```bash
git push -u origin mpg/1486957921458720788-engineer
```

Then create PR:
```bash
gh pr create --title "feat(#64): pulse activity integration — events, API, dashboard" --body "$(cat <<'EOF'
## Summary
- Adds pulse event emitter that writes session lifecycle events to `~/.pulse/events/mpg-sessions.jsonl`
- Hooks emitter into session-manager.ts at all lifecycle points (start, end, idle, resume, message_routed)
- Adds `/api/activity/sessions` and `/api/activity/summary` endpoints that proxy pulse CLI output
- Adds Activity tab to dashboard with Chart.js graphs (sessions over time, message volume, persona breakdown, peak concurrency, duration stats)
- Gracefully degrades when pulse CLI is unavailable

## Test plan
- [ ] `npx vitest run` — all tests pass
- [ ] `npx tsup` — build succeeds
- [ ] Manual: start MPG, send a message, verify JSONL event appears in `~/.pulse/events/mpg-sessions.jsonl`
- [ ] Manual: visit dashboard Activity tab, verify charts render (requires pulse CLI)
- [ ] Manual: verify dashboard loads with "Pulse CLI not available" notice when pulse is not installed

Closes #64

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
