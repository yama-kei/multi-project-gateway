import { existsSync } from 'node:fs';
import { runClaude, type ClaudeResult } from './claude-cli.js';
import type { SessionStore, PersistedSession } from './session-store.js';
import type { PulseEmitter } from './pulse-events.js';
import { createWorktree as gitCreateWorktree, removeWorktree as gitRemoveWorktree } from './worktree.js';
import { cleanupAttachments } from './attachments.js';

export interface SessionInfo {
  sessionId: string;
  projectKey: string;
  lastActivity: number;
  queueLength: number;
  createdAt: number;
  processing: boolean;
}

export interface SessionManager {
  send(projectKey: string, cwd: string, prompt: string, opts?: { worktree?: boolean; systemPrompt?: string; timeoutMs?: number; extraArgs?: string[] }): Promise<ClaudeResult>;
  getSession(projectKey: string): SessionInfo | undefined;
  listSessions(): SessionInfo[];
  clearSession(projectKey: string): boolean;
  restartSession(projectKey: string): boolean;
  shutdown(): void;
}

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
  resumeEmitted: boolean;
  processing: boolean;
  queue: Array<{
    prompt: string;
    systemPrompt?: string;
    timeoutMs?: number;
    extraArgs?: string[];
    resolve: (result: ClaudeResult) => void;
    reject: (error: Error) => void;
  }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export function createSessionManager(defaults: {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  sessionTtlMs?: number;
  maxPersistedSessions?: number;
  claudeArgs: string[];
}, store?: SessionStore, pulseEmitter?: PulseEmitter): SessionManager {
  const sessions = new Map<string, InternalSession>();
  const sessionTtlMs = defaults.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxPersistedSessions = defaults.maxPersistedSessions ?? 50;

  let activeProcesses = 0;
  const waiters: Array<() => void> = [];

  function pruneSessions(persisted: Map<string, PersistedSession>): number {
    const now = Date.now();
    let pruned = 0;

    // Remove sessions older than TTL
    for (const [key, entry] of persisted) {
      if (now - entry.lastActivity > sessionTtlMs) {
        persisted.delete(key);
        pruned++;
      }
    }

    // Enforce cap: evict oldest if over limit
    if (persisted.size > maxPersistedSessions) {
      const sorted = Array.from(persisted.entries())
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity);
      const toRemove = sorted.slice(0, persisted.size - maxPersistedSessions);
      for (const [key] of toRemove) {
        persisted.delete(key);
        pruned++;
      }
    }

    return pruned;
  }

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
    pruneSessions(persisted);
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
      // Clean up attachment files for the session's working directory (#110)
      cleanupAttachments(session.projectDir ?? session.cwd).catch(() => {});
      sessions.delete(session.projectKey);
    }, defaults.idleTimeoutMs);
  }

  async function processQueue(session: InternalSession): Promise<void> {
    if (session.processing || session.queue.length === 0) return;
    session.processing = true;

    while (session.queue.length > 0) {
      const item = session.queue.shift()!;
      const effectiveArgs = item.extraArgs ? [...defaults.claudeArgs, ...item.extraArgs] : defaults.claudeArgs;
      await acquireSlot();
      if (pulseEmitter) {
        // Session keys are "threadId:agentName" for agent sessions, "threadId" for default
        const agentTarget = session.projectKey.includes(':') ? session.projectKey.split(':').pop() : undefined;
        pulseEmitter.messageRouted(
          session.sessionId ?? session.projectKey,
          session.projectKey,
          session.cwd,
          { agentTarget, queueDepth: session.queue.length },
        );
      }
      try {
        const result = await runClaude(
          session.cwd,
          effectiveArgs,
          item.prompt,
          session.sessionId,
          item.systemPrompt,
          item.timeoutMs,
        );
        const sessionChanged = !!(
          session.sessionId &&
          result.sessionId &&
          result.sessionId !== session.sessionId
        );
        session.sessionId = result.sessionId || session.sessionId;
        session.lastActivity = Date.now();
        session.messageCount++;
        if (pulseEmitter && session.sessionId && result.usage) {
          const agentTarget = session.projectKey.includes(':') ? session.projectKey.split(':').pop() : undefined;
          pulseEmitter.messageCompleted(
            session.sessionId,
            session.projectKey,
            session.cwd,
            result.usage,
            { agentTarget },
          );
        }
        resetIdleTimer(session);
        persistSessions();
        if (sessionChanged) {
          item.resolve({ ...result, sessionChanged: true });
        } else {
          item.resolve(result);
        }
      } catch (err) {
        if (session.sessionId) {
          session.sessionId = undefined;
          try {
            const result = await runClaude(session.cwd, effectiveArgs, item.prompt, undefined, item.systemPrompt, item.timeoutMs);
            session.sessionId = result.sessionId || undefined;
            session.lastActivity = Date.now();
            session.messageCount++;
            if (pulseEmitter && session.sessionId && result.usage) {
              const agentTarget = session.projectKey.includes(':') ? session.projectKey.split(':').pop() : undefined;
              pulseEmitter.messageCompleted(
                session.sessionId,
                session.projectKey,
                session.cwd,
                result.usage,
                { agentTarget },
              );
            }
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
    if (session && session.restored && !session.resumeEmitted && pulseEmitter && session.sessionId) {
      session.resumeEmitted = true;
      pulseEmitter.sessionResume(
        session.sessionId,
        session.projectKey,
        session.cwd,
        Date.now() - session.lastActivity,
      );
    }
    if (!session) {
      // Check store for a previously persisted session ID
      let restoredSessionId: string | undefined;
      let restoredWorktreePath: string | undefined;
      let restoredLastActivity: number | undefined;
      if (store) {
        const persisted = store.load();
        const entry = persisted.get(projectKey);
        if (entry?.sessionId) {
          restoredSessionId = entry.sessionId;
          restoredWorktreePath = entry.worktreePath;
          restoredLastActivity = entry.lastActivity;
        }
      }

      let effectiveCwd = cwd;
      let worktreePath: string | undefined =
        restoredWorktreePath && existsSync(restoredWorktreePath)
          ? restoredWorktreePath
          : undefined;
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
        createdAt: Date.now(),
        messageCount: 0,
        restored: !!restoredSessionId,
        resumeEmitted: false,
        processing: false,
        queue: [],
        idleTimer: null,
      };
      sessions.set(projectKey, session);
      resetIdleTimer(session);
      if (pulseEmitter) {
        if (restoredSessionId) {
          session.resumeEmitted = true;
          pulseEmitter.sessionResume(
            restoredSessionId,
            projectKey,
            effectiveCwd,
            Date.now() - (restoredLastActivity ?? Date.now()),
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
    }
    return session;
  }

  // Restore persisted sessions into memory at startup, pruning stale entries
  if (store) {
    const persisted = store.load();
    const pruned = pruneSessions(persisted);
    if (pruned > 0) {
      console.log(`Pruned ${pruned} expired session(s)`);
      store.save(persisted);
    }
    for (const [key, entry] of persisted) {
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
        resumeEmitted: false,
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
    send(projectKey: string, cwd: string, prompt: string, opts?: { worktree?: boolean; systemPrompt?: string; timeoutMs?: number; extraArgs?: string[] }): Promise<ClaudeResult> {
      const session = getOrCreateSession(projectKey, cwd, opts?.worktree);
      return new Promise<ClaudeResult>((resolve, reject) => {
        session.queue.push({ prompt, systemPrompt: opts?.systemPrompt, timeoutMs: opts?.timeoutMs, extraArgs: opts?.extraArgs, resolve, reject });
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
        createdAt: session.createdAt,
        processing: session.processing,
      };
    },

    listSessions(): SessionInfo[] {
      return Array.from(sessions.values()).map((s) => ({
        sessionId: s.sessionId ?? '',
        projectKey: s.projectKey,
        lastActivity: s.lastActivity,
        queueLength: s.queue.length,
        createdAt: s.createdAt,
        processing: s.processing,
      }));
    },

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
      // Clean up attachment files (#110)
      cleanupAttachments(session.projectDir ?? session.cwd).catch(() => {});
      sessions.delete(projectKey);
      persistSessions();
      return true;
    },

    restartSession(projectKey: string): boolean {
      const session = sessions.get(projectKey);
      if (!session) return false;
      session.sessionId = undefined;
      session.lastActivity = Date.now();
      resetIdleTimer(session);
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
