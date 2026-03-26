import { createServer, type Server } from 'node:http';
import type { SessionManager } from './session-manager.js';
import type { DiscordBot } from './discord.js';

export interface HealthServer {
  close(): Promise<void>;
}

export function createHealthServer(
  port: number,
  sessionManager: SessionManager,
  bot: DiscordBot,
): Promise<HealthServer> {
  const startTime = Date.now();

  const server: Server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', `http://localhost`);
    if (req.method === 'GET' && pathname === '/health') {
      const sessions = sessionManager.listSessions();

      const body = JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        sessions: {
          active: sessions.length,
          queued: sessions.reduce((sum, s) => sum + s.queueLength, 0),
        },
        discord: bot.getStatus(),
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return new Promise<HealthServer>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      console.log(`Health endpoint listening on http://localhost:${port}/health`);
      resolve({
        close() {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}
