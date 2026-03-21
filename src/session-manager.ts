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
