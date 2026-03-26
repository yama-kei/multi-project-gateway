import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { SessionManager } from './session-manager.js';
import type { DiscordBot } from './discord.js';
import type { GatewayConfig } from './config.js';

export interface HealthServer {
  close(): Promise<void>;
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MPG Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  .card-value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .status-ok { color: #3fb950; }
  .status-warn { color: #d29922; }
  .status-err { color: #f85149; }
  h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
  th { text-align: left; padding: 10px 14px; font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #30363d; }
  td { padding: 10px 14px; font-size: 14px; border-bottom: 1px solid #21262d; }
  tr:last-child td { border-bottom: none; }
  .empty { color: #8b949e; font-style: italic; padding: 24px; text-align: center; }
  .refresh-info { color: #484f58; font-size: 12px; text-align: right; }
</style>
</head>
<body>
<h1>Multi-Project Gateway</h1>
<p class="subtitle" id="version"></p>

<div class="grid">
  <div class="card">
    <div class="card-label">Status</div>
    <div class="card-value" id="status">—</div>
  </div>
  <div class="card">
    <div class="card-label">Uptime</div>
    <div class="card-value" id="uptime">—</div>
  </div>
  <div class="card">
    <div class="card-label">Active Sessions</div>
    <div class="card-value" id="sessions-active">—</div>
  </div>
  <div class="card">
    <div class="card-label">Queued Messages</div>
    <div class="card-value" id="sessions-queued">—</div>
  </div>
  <div class="card">
    <div class="card-label">Discord</div>
    <div class="card-value" id="discord">—</div>
  </div>
</div>

<h2>Sessions</h2>
<div id="sessions-table"></div>

<h2>Projects</h2>
<div id="projects-table"></div>

<p class="refresh-info">Auto-refreshes every 5s</p>

<script>
function formatUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  return h + 'h ' + m + 'm';
}
function formatAgo(ts) {
  var diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  return Math.floor(diff / 3600) + 'h ago';
}
function statusClass(v) {
  if (v === 'ok' || v === 'connected') return 'status-ok';
  if (v === 'reconnecting') return 'status-warn';
  return 'status-err';
}
function escapeHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function refresh() {
  fetch('/api/status')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      document.getElementById('version').textContent = 'v' + d.version;
      var statusEl = document.getElementById('status');
      statusEl.textContent = d.health.status;
      statusEl.className = 'card-value ' + statusClass(d.health.status);
      document.getElementById('uptime').textContent = formatUptime(d.health.uptime);
      document.getElementById('sessions-active').textContent = d.health.sessions.active;
      document.getElementById('sessions-queued').textContent = d.health.sessions.queued;
      var discordEl = document.getElementById('discord');
      discordEl.textContent = d.health.discord;
      discordEl.className = 'card-value ' + statusClass(d.health.discord);

      // Sessions table
      var st = document.getElementById('sessions-table');
      if (d.sessions.length === 0) {
        st.innerHTML = '<div class="empty">No active sessions</div>';
      } else {
        var h = '<table><tr><th>Project</th><th>Session ID</th><th>Last Activity</th><th>Queue</th></tr>';
        for (var i = 0; i < d.sessions.length; i++) {
          var s = d.sessions[i];
          h += '<tr><td>' + escapeHtml(s.projectKey) + '</td><td>' + escapeHtml(s.sessionId ? s.sessionId.slice(0, 12) + '...' : '—') + '</td><td>' + formatAgo(s.lastActivity) + '</td><td>' + s.queueLength + '</td></tr>';
        }
        h += '</table>';
        st.innerHTML = h;
      }

      // Projects table
      var pt = document.getElementById('projects-table');
      if (d.projects.length === 0) {
        pt.innerHTML = '<div class="empty">No projects configured</div>';
      } else {
        var h2 = '<table><tr><th>Name</th><th>Directory</th><th>Agents</th></tr>';
        for (var j = 0; j < d.projects.length; j++) {
          var p = d.projects[j];
          h2 += '<tr><td>' + escapeHtml(p.name) + '</td><td>' + escapeHtml(p.directory) + '</td><td>' + escapeHtml(p.agents.join(', ') || '—') + '</td></tr>';
        }
        h2 += '</table>';
        pt.innerHTML = h2;
      }
    })
    .catch(function() {
      document.getElementById('status').textContent = 'error';
      document.getElementById('status').className = 'card-value status-err';
    });
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

export function createHealthServer(
  port: number,
  sessionManager: SessionManager,
  bot: DiscordBot,
  config?: GatewayConfig,
): Promise<HealthServer> {
  const startTime = Date.now();
  const version = getVersion();
  const dashboardHtml = buildDashboardHtml();

  function getHealthData() {
    const sessions = sessionManager.listSessions();
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      sessions: {
        active: sessions.length,
        queued: sessions.reduce((sum, s) => sum + s.queueLength, 0),
      },
      discord: bot.getStatus(),
    };
  }

  function getProjectsData() {
    if (!config) return [];
    return Object.entries(config.projects).map(([channelId, project]) => ({
      channelId,
      name: project.name,
      directory: project.directory,
      agents: project.agents ? Object.keys(project.agents) : [],
    }));
  }

  const server: Server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', `http://localhost`);

    if (req.method !== 'GET') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    if (pathname === '/health') {
      const body = JSON.stringify(getHealthData());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (pathname === '/api/sessions') {
      const body = JSON.stringify(sessionManager.listSessions());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (pathname === '/api/projects') {
      const body = JSON.stringify(getProjectsData());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (pathname === '/api/status') {
      const body = JSON.stringify({
        version,
        health: getHealthData(),
        sessions: sessionManager.listSessions(),
        projects: getProjectsData(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(dashboardHtml);
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
