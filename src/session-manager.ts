import { runClaude, type ClaudeResult } from './claude-cli.js';
import type { SessionStore, PersistedSession } from './session-store.js';
import { createWorktree as gitCreateWorktree, removeWorktree as gitRemoveWorktree } from './worktree.js';

export interface SessionInfo {
  sessionId: string;
  projectKey: string;
  lastActivity: number;
  queueLength: number;
}

export interface SessionManager {
  send(projectKey: string, cwd: string, prompt: string, opts?: { worktree?: boolean }): Promise<ClaudeResult>;
  getSession(projectKey: string): SessionInfo | undefined;
  listSessions(): SessionInfo[];
  clearSession(projectKey: string): boolean;
  shutdown(): void;
}

interface InternalSession {
  sessionId: string | undefined;
  projectKey: string;
  cwd: string;
  projectDir: string | undefined;
  worktreePath: string | undefined;
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
  idleTimeoutMinutes: number;
  maxConcurrentSessions: number;
  claudeArgs: string[];
}, store?: SessionStore): SessionManager {
  const sessions = new Map<string, InternalSession>();

  let activeProcesses = 0;
  const waiters: Array<() => void> = [];

  function persistSessions(): void {
    if (!store) return;
    // Merge in-memory sessions with existing persisted data.
    // In-memory sessions take precedence; persisted-only entries are preserved.
    const persisted = store.load();
    for (const [key, s] of sessions) {
      if (s.sessionId) {
        persisted.set(key, {
          sessionId: s.sessionId,
          projectKey: s.projectKey,
          cwd: s.cwd,
          lastActivity: s.lastActivity,
          worktreePath: s.worktreePath,
          projectDir: s.projectDir,
        });
      }
    }
    store.save(persisted);
  }

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
      // Remove from memory only; session ID and worktree stay on disk for later resume.
      // Worktrees persist on idle intentionally — cleaned up on !kill or startup reconciliation.
      sessions.delete(session.projectKey);
    }, defaults.idleTimeoutMinutes * 60_000);
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
        persistSessions();
        item.resolve(result);
      } catch (err) {
        if (session.sessionId) {
          session.sessionId = undefined;
          try {
            const result = await runClaude(session.cwd, defaults.claudeArgs, item.prompt, undefined);
            session.sessionId = result.sessionId || undefined;
            session.lastActivity = Date.now();
            resetIdleTimer(session);
            persistSessions();
            item.resolve({ ...result, sessionReset: true });
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

  function getOrCreateSession(projectKey: string, cwd: string, useWorktree?: boolean): InternalSession {
    let session = sessions.get(projectKey);
    if (!session) {
      // Check store for a previously persisted session ID
      let restoredSessionId: string | undefined;
      let restoredWorktreePath: string | undefined;
      if (store) {
        const persisted = store.load();
        const entry = persisted.get(projectKey);
        if (entry?.sessionId) {
          restoredSessionId = entry.sessionId;
          restoredWorktreePath = entry.worktreePath;
        }
      }

      let effectiveCwd = cwd;
      let worktreePath: string | undefined = restoredWorktreePath;
      let projectDir: string | undefined;

      if (useWorktree && !worktreePath) {
        worktreePath = gitCreateWorktree(cwd, projectKey);
      }
      if (worktreePath) {
        projectDir = cwd;
        effectiveCwd = worktreePath;
      }

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
      sessions.set(projectKey, session);
      resetIdleTimer(session);
    }
    return session;
  }

  // Restore persisted sessions into memory at startup
  if (store) {
    const persisted = store.load();
    for (const [key, entry] of persisted) {
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
    }
    for (const session of sessions.values()) {
      resetIdleTimer(session);
    }
    if (persisted.size > 0) {
      console.log(`Restored ${persisted.size} session(s) from disk`);
    }
  }

  return {
    send(projectKey: string, cwd: string, prompt: string, opts?: { worktree?: boolean }): Promise<ClaudeResult> {
      const session = getOrCreateSession(projectKey, cwd, opts?.worktree);
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

    shutdown() {
      persistSessions();
      for (const session of sessions.values()) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
      }
      sessions.clear();
    },
  };
}
