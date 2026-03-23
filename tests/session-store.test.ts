import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileSessionStore, type PersistedSession } from '../src/session-store.js';

describe('FileSessionStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-store-'));
    filePath = join(dir, 'sessions.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty map when file does not exist', () => {
    const store = createFileSessionStore(filePath);
    const result = store.load();
    expect(result.size).toBe(0);
  });

  it('saves and loads sessions', () => {
    const store = createFileSessionStore(filePath);
    const sessions = new Map<string, PersistedSession>();
    sessions.set('ch-1', {
      sessionId: 'sid-1',
      projectKey: 'ch-1',
      cwd: '/tmp/a',
      lastActivity: 1000,
    });
    sessions.set('ch-2', {
      sessionId: 'sid-2',
      projectKey: 'ch-2',
      cwd: '/tmp/b',
      lastActivity: 2000,
    });

    store.save(sessions);

    const loaded = store.load();
    expect(loaded.size).toBe(2);
    expect(loaded.get('ch-1')?.sessionId).toBe('sid-1');
    expect(loaded.get('ch-2')?.cwd).toBe('/tmp/b');
  });

  it('overwrites previous data on save', () => {
    const store = createFileSessionStore(filePath);
    const first = new Map<string, PersistedSession>();
    first.set('ch-1', { sessionId: 'sid-1', projectKey: 'ch-1', cwd: '/tmp/a', lastActivity: 1000 });
    store.save(first);

    const second = new Map<string, PersistedSession>();
    second.set('ch-2', { sessionId: 'sid-2', projectKey: 'ch-2', cwd: '/tmp/b', lastActivity: 2000 });
    store.save(second);

    const loaded = store.load();
    expect(loaded.size).toBe(1);
    expect(loaded.has('ch-1')).toBe(false);
    expect(loaded.get('ch-2')?.sessionId).toBe('sid-2');
  });

  it('skips entries without sessionId', () => {
    const store = createFileSessionStore(filePath);
    const raw = JSON.stringify([
      { sessionId: 'sid-1', projectKey: 'ch-1', cwd: '/tmp/a', lastActivity: 1000 },
      { sessionId: '', projectKey: 'ch-2', cwd: '/tmp/b', lastActivity: 2000 },
    ]);
    require('node:fs').writeFileSync(filePath, raw);

    const loaded = store.load();
    expect(loaded.size).toBe(1);
    expect(loaded.has('ch-1')).toBe(true);
  });

  it('returns empty map on corrupted file', () => {
    const store = createFileSessionStore(filePath);
    require('node:fs').writeFileSync(filePath, 'not json');
    const loaded = store.load();
    expect(loaded.size).toBe(0);
  });

  it('writes valid JSON to disk', () => {
    const store = createFileSessionStore(filePath);
    const sessions = new Map<string, PersistedSession>();
    sessions.set('ch-1', { sessionId: 'sid-1', projectKey: 'ch-1', cwd: '/tmp/a', lastActivity: 1000 });
    store.save(sessions);

    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBe('sid-1');
  });
});
