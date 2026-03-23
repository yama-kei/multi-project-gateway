import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PersistedSession {
  sessionId: string;
  projectKey: string;
  cwd: string;
  lastActivity: number;
  worktreePath?: string;
  projectDir?: string;
}

export interface SessionStore {
  load(): Map<string, PersistedSession>;
  save(sessions: Map<string, PersistedSession>): void;
}

export function createFileSessionStore(filePath: string): SessionStore {
  return {
    load(): Map<string, PersistedSession> {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const entries: PersistedSession[] = JSON.parse(raw);
        const map = new Map<string, PersistedSession>();
        for (const entry of entries) {
          if (entry.sessionId && entry.projectKey) {
            map.set(entry.projectKey, entry);
          }
        }
        return map;
      } catch {
        return new Map();
      }
    },

    save(sessions: Map<string, PersistedSession>): void {
      const entries = Array.from(sessions.values());
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, JSON.stringify(entries, null, 2) + '\n');
      } catch (err) {
        console.error('Failed to persist sessions:', err);
      }
    },
  };
}
