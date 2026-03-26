import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import { createHealthServer, type HealthServer } from '../src/health-server.js';
import type { SessionManager, SessionInfo } from '../src/session-manager.js';
import type { DiscordBot } from '../src/discord.js';

function makeSessionManager(sessions: SessionInfo[] = []): SessionManager {
  return {
    send: () => Promise.reject(new Error('not implemented')),
    getSession: () => undefined,
    listSessions: () => sessions,
    clearSession: () => false,
    restartSession: () => false,
    shutdown: () => {},
  };
}

function makeBot(status = 'connected'): DiscordBot {
  return {
    start: () => Promise.resolve(),
    stop: () => {},
    getStatus: () => status,
  };
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createHealthServer', () => {
  let server: HealthServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('returns 200 with health JSON on GET /health', async () => {
    const sessions: SessionInfo[] = [
      { sessionId: 'sess-1', projectKey: 'ch-1', lastActivity: Date.now(), queueLength: 0 },
      { sessionId: 'sess-2', projectKey: 'ch-2', lastActivity: Date.now(), queueLength: 2 },
    ];
    server = await createHealthServer(0, makeSessionManager(sessions), makeBot('connected'));

    // Extract the actual port from the server (port 0 means OS-assigned)
    const addr = (server as any);
    // We need the actual port — use a different approach: pass a known port
    await server.close();

    // Use a specific port for the test
    const port = 19876;
    server = await createHealthServer(port, makeSessionManager(sessions), makeBot('connected'));

    const res = await httpGet(port, '/health');
    expect(res.status).toBe(200);

    const json = JSON.parse(res.body);
    expect(json.status).toBe('ok');
    expect(typeof json.uptime).toBe('number');
    expect(json.uptime).toBeGreaterThanOrEqual(0);
    expect(json.sessions.active).toBe(2);
    expect(json.sessions.queued).toBe(2);
    expect(json.discord).toBe('connected');
  });

  it('returns 404 for unknown routes', async () => {
    const port = 19877;
    server = await createHealthServer(port, makeSessionManager(), makeBot());

    const res = await httpGet(port, '/unknown');
    expect(res.status).toBe(404);

    const json = JSON.parse(res.body);
    expect(json.error).toBe('Not Found');
  });

  it('returns 404 for POST /health', async () => {
    const port = 19878;
    server = await createHealthServer(port, makeSessionManager(), makeBot());

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/health', method: 'POST' }, (r) => {
        let data = '';
        r.on('data', (chunk) => { data += chunk; });
        r.on('end', () => resolve({ status: r.statusCode!, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(404);
  });

  it('reports zero sessions when none exist', async () => {
    const port = 19879;
    server = await createHealthServer(port, makeSessionManager([]), makeBot());

    const res = await httpGet(port, '/health');
    const json = JSON.parse(res.body);
    expect(json.sessions.active).toBe(0);
    expect(json.sessions.queued).toBe(0);
  });

  it('reflects discord status from bot', async () => {
    const port = 19880;
    server = await createHealthServer(port, makeSessionManager(), makeBot('reconnecting'));

    const res = await httpGet(port, '/health');
    const json = JSON.parse(res.body);
    expect(json.discord).toBe('reconnecting');
  });

  it('closes gracefully', async () => {
    const port = 19881;
    server = await createHealthServer(port, makeSessionManager(), makeBot());
    await server.close();
    server = undefined;

    // Should fail to connect after close
    await expect(httpGet(port, '/health')).rejects.toThrow();
  });
});
