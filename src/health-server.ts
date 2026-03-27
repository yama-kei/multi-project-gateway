import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
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

function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MPG Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: #8b949e; font-size: 13px; margin-bottom: 8px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 24px; }
  .tab { background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #8b949e; padding: 8px 16px; cursor: pointer; font-size: 14px; }
  .tab.active { color: #e1e4e8; border-color: #58a6ff; background: #1c2333; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  .card-value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .status-ok { color: #3fb950; }
  .status-warn { color: #d29922; }
  .status-err { color: #f85149; }
  h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #8b949e; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
  th { text-align: left; padding: 10px 14px; font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #30363d; }
  td { padding: 10px 14px; font-size: 14px; border-bottom: 1px solid #21262d; }
  tr:last-child td { border-bottom: none; }
  .empty { color: #8b949e; font-style: italic; padding: 24px; text-align: center; }
  .refresh-info { color: #484f58; font-size: 12px; text-align: right; }
  .range-selector { display: flex; gap: 8px; margin-bottom: 16px; }
  .range-btn { background: #161b22; border: 1px solid #30363d; border-radius: 4px; color: #8b949e; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  .range-btn.active { color: #e1e4e8; border-color: #58a6ff; }
  .chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .chart-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .chart-card h3 { margin-bottom: 12px; }
</style>
</head>
<body>
<h1>Multi-Project Gateway</h1>
<p class="subtitle" id="version"></p>
<div class="tabs">
  <button class="tab active" onclick="switchTab('overview')">Overview</button>
  <button class="tab" onclick="switchTab('activity')">Activity</button>
</div>

<div id="tab-overview">
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
</div>

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

var chartInstances = {};
var currentRange = '7d';
var CHART_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#79c0ff'];

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(t) {
    if (t.textContent.toLowerCase() === tab) t.classList.add('active');
  });
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

function refreshActivity() {
  var bucket = currentRange === '24h' ? 'hour' : 'day';
  fetch('/api/activity/summary?range=' + currentRange + '&bucket=' + bucket)
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
      if (pLabels.length > 0) {
        chartInstances['persona'] = new Chart(document.getElementById('persona-chart'), {
          type: 'doughnut',
          data: { labels: pLabels, datasets: [{ data: pData, backgroundColor: CHART_COLORS.slice(0, pLabels.length) }] },
          options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
        });
      }

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
        var dh = '<table><tr><th>Project</th><th>Avg</th><th>Median</th><th>P95</th></tr>';
        d.duration_stats.forEach(function(s) {
          dh += '<tr><td>' + escapeHtml(s.project_key) + '</td><td>' + (s.avg_ms / 60000).toFixed(1) + 'm</td><td>' + (s.median_ms / 60000).toFixed(1) + 'm</td><td>' + (s.p95_ms / 60000).toFixed(1) + 'm</td></tr>';
        });
        dh += '</table>';
        dt.innerHTML = dh;
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
</script>
</body>
</html>`;
}

export function createHealthServer(
  port: number,
  sessionManager: SessionManager,
  bot: DiscordBot,
  config?: GatewayConfig,
  options?: HealthServerOptions,
): Promise<HealthServer> {
  const startTime = Date.now();
  const version = getVersion();
  const dashboardHtml = buildDashboardHtml();
  const runPulse = options?.runPulseCli ?? defaultRunPulseCli;

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
