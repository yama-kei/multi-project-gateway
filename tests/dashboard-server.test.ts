import { describe, it, expect, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { createDashboardServer, type DashboardServer } from '../src/dashboard-server.js';
import type { SessionManager, SessionInfo } from '../src/session-manager.js';
import type { ChannelAdapter } from '../src/adapter.js';
import type { GatewayConfig } from '../src/config.js';

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

function makeBot(status = 'connected', guildId: string | null = null): ChannelAdapter {
  return {
    start: () => Promise.resolve(),
    stop: () => {},
    getStatus: () => status,
    getGuildId: () => guildId,
    deliverOrphanResult: async () => {},
  };
}

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    defaults: {
      idleTimeoutMs: 1800000,
      maxConcurrentSessions: 4,
      sessionTtlMs: 604800000,
      maxPersistedSessions: 50,
      claudeArgs: [],
      allowedTools: [],
      disallowedTools: [],
      maxTurnsPerAgent: 5,
      agentTimeoutMs: 180000,
      httpPort: 3100,
      logLevel: 'info',
    },
    projects: {
      'ch-1': {
        name: 'My Project',
        directory: '/home/user/project',
        agents: { pm: { role: 'PM', prompt: 'You are a PM' }, engineer: { role: 'Engineer', prompt: 'You are an engineer' } },
      },
      'ch-2': {
        name: 'Other Project',
        directory: '/home/user/other',
      },
    },
    ...overrides,
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

// Use a port counter to avoid conflicts across tests
let nextPort = 19876;
function getPort() { return nextPort++; }

describe('createDashboardServer', () => {
  let server: DashboardServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('returns 200 with health JSON on GET /health', async () => {
    const port = getPort();
    const sessions: SessionInfo[] = [
      { sessionId: 'sess-1', projectKey: 'ch-1', cwd: '/home/user/project', lastActivity: Date.now(), queueLength: 0 },
      { sessionId: 'sess-2', projectKey: 'ch-2', cwd: '/home/user/other', lastActivity: Date.now(), queueLength: 2 },
    ];
    server = await createDashboardServer(port, makeSessionManager(sessions), makeBot('connected'));

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
    const port = getPort();
    server = await createDashboardServer(port, makeSessionManager(), makeBot());

    const res = await httpGet(port, '/unknown');
    expect(res.status).toBe(404);

    const json = JSON.parse(res.body);
    expect(json.error).toBe('Not Found');
  });

  it('returns 404 for POST /health', async () => {
    const port = getPort();
    server = await createDashboardServer(port, makeSessionManager(), makeBot());

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
    const port = getPort();
    server = await createDashboardServer(port, makeSessionManager([]), makeBot());

    const res = await httpGet(port, '/health');
    const json = JSON.parse(res.body);
    expect(json.sessions.active).toBe(0);
    expect(json.sessions.queued).toBe(0);
  });

  it('reflects discord status from bot', async () => {
    const port = getPort();
    server = await createDashboardServer(port, makeSessionManager(), makeBot('reconnecting'));

    const res = await httpGet(port, '/health');
    const json = JSON.parse(res.body);
    expect(json.discord).toBe('reconnecting');
  });

  it('closes gracefully', async () => {
    const port = getPort();
    server = await createDashboardServer(port, makeSessionManager(), makeBot());
    await server.close();
    server = undefined;

    // Should fail to connect after close
    await expect(httpGet(port, '/health')).rejects.toThrow();
  });

  // --- New API endpoint tests ---

  describe('GET /api/sessions', () => {
    it('returns session list', async () => {
      const port = getPort();
      const sessions: SessionInfo[] = [
        { sessionId: 'sess-1', projectKey: 'ch-1', cwd: '/home/user/project', lastActivity: 1700000000000, queueLength: 3 },
      ];
      server = await createDashboardServer(port, makeSessionManager(sessions), makeBot());

      const res = await httpGet(port, '/api/sessions');
      expect(res.status).toBe(200);

      const json = JSON.parse(res.body);
      expect(json).toHaveLength(1);
      expect(json[0].sessionId).toBe('sess-1');
      expect(json[0].projectKey).toBe('ch-1');
      expect(json[0].lastActivity).toBe(1700000000000);
      expect(json[0].queueLength).toBe(3);
    });

    it('returns empty array when no sessions', async () => {
      const port = getPort();
      server = await createDashboardServer(port, makeSessionManager([]), makeBot());

      const res = await httpGet(port, '/api/sessions');
      const json = JSON.parse(res.body);
      expect(json).toEqual([]);
    });
  });

  describe('GET /api/projects', () => {
    it('returns project list with agents when config provided', async () => {
      const port = getPort();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig());

      const res = await httpGet(port, '/api/projects');
      expect(res.status).toBe(200);

      const json = JSON.parse(res.body);
      expect(json).toHaveLength(2);

      const proj1 = json.find((p: any) => p.channelId === 'ch-1');
      expect(proj1.name).toBe('My Project');
      expect(proj1.directory).toBe('/home/user/project');
      expect(proj1.agents).toEqual(['pm', 'engineer']);

      const proj2 = json.find((p: any) => p.channelId === 'ch-2');
      expect(proj2.name).toBe('Other Project');
      expect(proj2.agents).toEqual([]);
    });

    it('returns empty array when no config provided', async () => {
      const port = getPort();
      server = await createDashboardServer(port, makeSessionManager(), makeBot());

      const res = await httpGet(port, '/api/projects');
      const json = JSON.parse(res.body);
      expect(json).toEqual([]);
    });
  });

  describe('GET /api/status', () => {
    it('returns combined status overview', async () => {
      const port = getPort();
      const sessions: SessionInfo[] = [
        { sessionId: 'sess-1', projectKey: 'ch-1', cwd: '/home/user/project', lastActivity: Date.now(), queueLength: 1 },
      ];
      server = await createDashboardServer(port, makeSessionManager(sessions), makeBot('connected'), makeConfig());

      const res = await httpGet(port, '/api/status');
      expect(res.status).toBe(200);

      const json = JSON.parse(res.body);

      // Version
      expect(typeof json.version).toBe('string');

      // Health sub-object
      expect(json.health.status).toBe('ok');
      expect(typeof json.health.uptime).toBe('number');
      expect(json.health.sessions.active).toBe(1);
      expect(json.health.sessions.queued).toBe(1);
      expect(json.health.discord).toBe('connected');

      // Sessions array
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0].sessionId).toBe('sess-1');

      // Projects array
      expect(json.projects).toHaveLength(2);
    });

    it('includes discordGuildId when bot has guild', async () => {
      const port = getPort();
      const sessions: SessionInfo[] = [
        { sessionId: 'sess-1', projectKey: 'ch-1', cwd: '/home/user/project', lastActivity: Date.now(), queueLength: 0 },
      ];
      server = await createDashboardServer(port, makeSessionManager(sessions), makeBot('connected', '999888777'), makeConfig());

      const res = await httpGet(port, '/api/status');
      const json = JSON.parse(res.body);

      expect(json.discordGuildId).toBe('999888777');
    });

    it('constructs discord:// deep link when session has guildId', async () => {
      const port = getPort();
      const sessions: SessionInfo[] = [
        { sessionId: 'sess-1', projectKey: 'ch-1', cwd: '/tmp', lastActivity: Date.now(), queueLength: 0, guildId: '111222333' },
      ];
      server = await createDashboardServer(port, makeSessionManager(sessions), makeBot('connected'), makeConfig());

      const res = await httpGet(port, '/api/status');
      const json = JSON.parse(res.body);

      expect(json.sessions[0].sourceUrl).toBe('discord://discord.com/channels/111222333/ch-1');
    });

    it('falls back to bot guildId when session has no guildId', async () => {
      const port = getPort();
      const sessions: SessionInfo[] = [
        { sessionId: 'sess-1', projectKey: 'ch-1', cwd: '/tmp', lastActivity: Date.now(), queueLength: 0 },
      ];
      server = await createDashboardServer(port, makeSessionManager(sessions), makeBot('connected', '444555666'), makeConfig());

      const res = await httpGet(port, '/api/status');
      const json = JSON.parse(res.body);

      expect(json.sessions[0].sourceUrl).toBe('discord://discord.com/channels/444555666/ch-1');
    });

    it('omits sourceUrl when no guildId is available', async () => {
      const port = getPort();
      const sessions: SessionInfo[] = [
        { sessionId: 'sess-1', projectKey: 'ch-1', cwd: '/tmp', lastActivity: Date.now(), queueLength: 0 },
      ];
      server = await createDashboardServer(port, makeSessionManager(sessions), makeBot('connected'), makeConfig());

      const res = await httpGet(port, '/api/status');
      const json = JSON.parse(res.body);

      expect(json.sessions[0].sourceUrl).toBeUndefined();
    });

    it('uses threadId from projectKey with agent suffix for deep link', async () => {
      const port = getPort();
      const sessions: SessionInfo[] = [
        { sessionId: 'sess-1', projectKey: 'ch-1:engineer', cwd: '/tmp', lastActivity: Date.now(), queueLength: 0, guildId: '777888999' },
      ];
      server = await createDashboardServer(port, makeSessionManager(sessions), makeBot('connected'), makeConfig());

      const res = await httpGet(port, '/api/status');
      const json = JSON.parse(res.body);

      expect(json.sessions[0].sourceUrl).toBe('discord://discord.com/channels/777888999/ch-1');
    });
  });

  describe('activity endpoints', () => {
    function makeMockEngine() {
      return {
        computeSummary: vi.fn().mockReturnValue({
          total_cost_usd: 1.23, total_input_tokens: 500000, total_output_tokens: 50000,
          total_sessions: 10, total_messages: 42, avg_session_duration_ms: 120000,
        }),
        tokensByProject: vi.fn().mockReturnValue([
          { project_name: 'proj-a', input_tokens: 300000, output_tokens: 30000, cache_read_input_tokens: 100000, cost_usd: 0.8, message_count: 25 },
        ]),
        tokensBySession: vi.fn().mockReturnValue([
          { session_id: 'sess-1', project_key: 'proj-a', input_tokens: 150000, output_tokens: 15000, cost_usd: 0.4, message_count: 12, duration_ms: 60000 },
        ]),
        bucketed: vi.fn().mockReturnValue([{ bucket: '2026-03-27T00:00:00.000Z', value: 5 }]),
        sessionDurations: vi.fn().mockReturnValue([{ session_id: 'sess-1', project_key: 'proj-a', duration_ms: 60000 }]),
        modelBreakdown: vi.fn().mockReturnValue([{ model: 'claude-sonnet-4-20250514', input_tokens: 500000, output_tokens: 50000, cost_usd: 1.23 }]),
        personaBreakdown: vi.fn().mockReturnValue([{ agent: 'engineer', count: 25 }]),
        cacheEfficiency: vi.fn().mockReturnValue({ total_input_tokens: 500000, cache_read_tokens: 200000, cache_hit_ratio: 0.4 }),
        turnComplexity: vi.fn().mockReturnValue({ low: 5, medium: 3, high: 2 }),
        sessionRetries: vi.fn().mockReturnValue([{ session_id: 'sess-1', project_key: 'proj-a', agent: 'engineer', user_turns: 4, retries: 1 }]),
        sessionTimeline: vi.fn().mockReturnValue([]),
      };
    }

    it('GET /api/activity/summary returns aggregated activity data', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      const res = await httpGet(port, '/api/activity/summary?range=7d');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary.total_cost_usd).toBe(1.23);
      expect(body.summary.total_sessions).toBe(10);
      expect(body.tokens_by_project).toHaveLength(1);
      expect(body.model_breakdown).toHaveLength(1);
      expect(body.cache_efficiency.cache_hit_ratio).toBe(0.4);
      expect(engine.computeSummary).toHaveBeenCalledWith('7d');
    });

    it('GET /api/activity/summary uses hour bucket for 24h range', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      await httpGet(port, '/api/activity/summary?range=24h');
      const bucketedCalls = engine.bucketed.mock.calls;
      for (const call of bucketedCalls) {
        expect(call[1]).toBe('hour');
      }
    });

    it('GET /api/activity/summary returns empty data when no engine provided', async () => {
      const port = getPort();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig());
      const res = await httpGet(port, '/api/activity/summary');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary.total_cost_usd).toBe(0);
      expect(body.summary.total_sessions).toBe(0);
      expect(body.tokens_by_project).toEqual([]);
      expect(body.input_tokens_over_time).toEqual([]);
      expect(body.output_tokens_over_time).toEqual([]);
      expect(body.cache_read_over_time).toEqual([]);
      expect(body.project_name_map).toEqual({});
    });

    it('GET /api/activity/summary includes turn_complexity and session_retries enrichment', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      const res = await httpGet(port, '/api/activity/summary?range=7d');
      const body = JSON.parse(res.body);
      expect(body.turn_complexity).toEqual({ low: 5, medium: 3, high: 2 });
      expect(body.session_retries).toEqual([{ session_id: 'sess-1', project_key: 'proj-a', agent: 'engineer', user_turns: 4, retries: 1 }]);
      expect(engine.turnComplexity).toHaveBeenCalledWith('7d');
      expect(engine.sessionRetries).toHaveBeenCalledWith('7d');
    });

    it('GET /api/activity/summary returns empty enrichment when no engine provided', async () => {
      const port = getPort();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig());
      const res = await httpGet(port, '/api/activity/summary');
      const body = JSON.parse(res.body);
      expect(body.turn_complexity).toEqual({ low: 0, medium: 0, high: 0 });
      expect(body.session_retries).toEqual([]);
    });

    it('GET /api/activity/summary includes project_name_map and dir_to_name_map from config', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      const res = await httpGet(port, '/api/activity/summary?range=7d');
      const body = JSON.parse(res.body);
      expect(body.project_name_map).toEqual({ 'ch-1': 'My Project', 'ch-2': 'Other Project' });
      expect(body.dir_to_name_map).toEqual({ '/home/user/project': 'My Project', '/home/user/other': 'Other Project' });
    });
  });

  describe('GET /api/activity/timeline', () => {
    function makeMockEngine() {
      return {
        computeSummary: vi.fn().mockReturnValue({
          total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0,
          total_sessions: 0, total_messages: 0, avg_session_duration_ms: 0,
        }),
        tokensByProject: vi.fn().mockReturnValue([]),
        tokensBySession: vi.fn().mockReturnValue([]),
        bucketed: vi.fn().mockReturnValue([]),
        sessionDurations: vi.fn().mockReturnValue([]),
        modelBreakdown: vi.fn().mockReturnValue([]),
        personaBreakdown: vi.fn().mockReturnValue([]),
        cacheEfficiency: vi.fn().mockReturnValue({ total_input_tokens: 0, cache_read_tokens: 0, cache_hit_ratio: 0 }),
        turnComplexity: vi.fn().mockReturnValue({ low: 0, medium: 0, high: 0 }),
        sessionRetries: vi.fn().mockReturnValue([]),
        sessionTimeline: vi.fn().mockReturnValue([
          {
            session_id: 'sess-12345678',
            label: 'mpg/sess-123/engineer',
            segments: [
              { start: '2026-03-29T10:00:00Z', end: '2026-03-29T10:01:00Z', state: 'idle' },
              { start: '2026-03-29T10:01:00Z', end: '2026-03-29T10:05:00Z', state: 'processing' },
            ],
          },
        ]),
      };
    }

    it('returns timeline data from engine', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      const res = await httpGet(port, '/api/activity/timeline?range=24h');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(1);
      expect(body[0].label).toBe('mpg/sess-123/engineer');
      expect(body[0].segments).toHaveLength(2);
      expect(engine.sessionTimeline).toHaveBeenCalledWith('24h', { 'ch-1': 'My Project', 'ch-2': 'Other Project' }, { '/home/user/project': 'My Project', '/home/user/other': 'Other Project' });
    });

    it('returns empty array when no engine provided', async () => {
      const port = getPort();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig());
      const res = await httpGet(port, '/api/activity/timeline?range=7d');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it('accepts 1h range and passes it to engine', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      const res = await httpGet(port, '/api/activity/timeline?range=1h');
      expect(res.status).toBe(200);
      expect(engine.sessionTimeline).toHaveBeenCalledWith('1h', { 'ch-1': 'My Project', 'ch-2': 'Other Project' }, { '/home/user/project': 'My Project', '/home/user/other': 'Other Project' });
    });

    it('accepts 3h range and passes it to engine', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      const res = await httpGet(port, '/api/activity/timeline?range=3h');
      expect(res.status).toBe(200);
      expect(engine.sessionTimeline).toHaveBeenCalledWith('3h', { 'ch-1': 'My Project', 'ch-2': 'Other Project' }, { '/home/user/project': 'My Project', '/home/user/other': 'Other Project' });
    });

    it('accepts 12h range and passes it to engine', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      const res = await httpGet(port, '/api/activity/timeline?range=12h');
      expect(res.status).toBe(200);
      expect(engine.sessionTimeline).toHaveBeenCalledWith('12h', { 'ch-1': 'My Project', 'ch-2': 'Other Project' }, { '/home/user/project': 'My Project', '/home/user/other': 'Other Project' });
    });

    it('returns 400 for invalid range', async () => {
      const port = getPort();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig());
      const res = await httpGet(port, '/api/activity/timeline?range=1y');
      expect(res.status).toBe(400);
    });

    it('rejects 1h, 3h, and 12h on summary endpoint (activity tab unchanged)', async () => {
      const port = getPort();
      server = await createDashboardServer(port, makeSessionManager(), makeBot(), makeConfig());
      const res1h = await httpGet(port, '/api/activity/summary?range=1h');
      expect(res1h.status).toBe(400);
      const res3h = await httpGet(port, '/api/activity/summary?range=3h');
      expect(res3h.status).toBe(400);
      const res12h = await httpGet(port, '/api/activity/summary?range=12h');
      expect(res12h.status).toBe(400);
    });
  });

  describe('GET /', () => {
    it('serves HTML dashboard', async () => {
      const port = getPort();
      server = await createDashboardServer(port, makeSessionManager(), makeBot());

      const res = await httpGet(port, '/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<!DOCTYPE html>');
      expect(res.body).toContain('Multi-Project Gateway');
      expect(res.body).toContain('/api/status');
    });
  });
});
