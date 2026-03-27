import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionManager } from './session-manager.js';
import type { DiscordBot } from './discord.js';
import type { GatewayConfig } from './config.js';
import {
  readEvents,
  computeSummary,
  tokensByProject,
  tokensBySession,
  bucketedCounts,
  bucketedSums,
  sessionDurations,
  modelBreakdown,
  personaBreakdown,
  cacheEfficiency,
} from './activity-engine.js';

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
  pulseEventsPath?: string;
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
  <div class="grid" id="activity-cards"></div>
  <div class="chart-grid">
    <div class="chart-card">
      <h3>Messages Over Time</h3>
      <canvas id="messages-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Cost Over Time</h3>
      <canvas id="cost-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Sessions Over Time</h3>
      <canvas id="sessions-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Token Usage Over Time</h3>
      <canvas id="tokens-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Persona Breakdown</h3>
      <canvas id="persona-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Model Breakdown</h3>
      <canvas id="model-chart"></canvas>
    </div>
  </div>
  <h3>Token Usage by Project</h3>
  <div id="project-tokens-table"></div>
  <h3>Token Usage by Session</h3>
  <div id="session-tokens-table"></div>
  <h3>Cache Efficiency</h3>
  <div id="cache-table"></div>
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

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

function fmtDuration(ms) {
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  var h = Math.floor(ms / 3600000);
  var m = Math.round((ms % 3600000) / 60000);
  return h + 'h ' + m + 'm';
}

function fmtCost(n) {
  return '$' + n.toFixed(2);
}

function chartOpts(hideLegend) {
  return {
    scales: {
      y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
      x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }
    },
    plugins: { legend: { display: !hideLegend, labels: { color: '#8b949e' } } }
  };
}

function refreshActivity() {
  fetch('/api/activity/summary?range=' + currentRange)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      // Summary cards
      var s = d.summary;
      document.getElementById('activity-cards').innerHTML =
        '<div class="card"><div class="card-label">Total Cost</div><div class="card-value">' + fmtCost(s.total_cost_usd) + '</div></div>' +
        '<div class="card"><div class="card-label">Total Tokens</div><div class="card-value">' + fmtTokens(s.total_input_tokens + s.total_output_tokens) + '</div></div>' +
        '<div class="card"><div class="card-label">Sessions</div><div class="card-value">' + s.total_sessions + '</div></div>' +
        '<div class="card"><div class="card-label">Messages</div><div class="card-value">' + s.total_messages + '</div></div>' +
        '<div class="card"><div class="card-label">Avg Duration</div><div class="card-value">' + fmtDuration(s.avg_session_duration_ms) + '</div></div>';

      // Messages Over Time
      var mLabels = d.messages_over_time.map(function(e) { return e.bucket; });
      var mData = d.messages_over_time.map(function(e) { return e.value; });
      destroyChart('messages');
      chartInstances['messages'] = new Chart(document.getElementById('messages-chart'), {
        type: 'bar',
        data: { labels: mLabels, datasets: [{ label: 'Messages', data: mData, backgroundColor: '#58a6ff' }] },
        options: chartOpts(true)
      });

      // Cost Over Time
      var cLabels = d.cost_over_time.map(function(e) { return e.bucket; });
      var cData = d.cost_over_time.map(function(e) { return e.value; });
      destroyChart('cost');
      chartInstances['cost'] = new Chart(document.getElementById('cost-chart'), {
        type: 'line',
        data: { labels: cLabels, datasets: [{ label: 'Cost ($)', data: cData, borderColor: '#3fb950', tension: 0.3 }] },
        options: chartOpts(true)
      });

      // Sessions Over Time
      var sLabels = d.sessions_over_time.map(function(e) { return e.bucket; });
      var sData = d.sessions_over_time.map(function(e) { return e.value; });
      destroyChart('sessions');
      chartInstances['sessions'] = new Chart(document.getElementById('sessions-chart'), {
        type: 'bar',
        data: { labels: sLabels, datasets: [{ label: 'Sessions', data: sData, backgroundColor: '#d29922' }] },
        options: chartOpts(true)
      });

      // Token Usage Over Time (stacked bar: input vs output)
      var allBuckets = {};
      d.input_tokens_over_time.forEach(function(e) { allBuckets[e.bucket] = true; });
      d.output_tokens_over_time.forEach(function(e) { allBuckets[e.bucket] = true; });
      var tLabels = Object.keys(allBuckets).sort();
      var inputMap = {}; d.input_tokens_over_time.forEach(function(e) { inputMap[e.bucket] = e.value; });
      var outputMap = {}; d.output_tokens_over_time.forEach(function(e) { outputMap[e.bucket] = e.value; });
      var tInputData = tLabels.map(function(b) { return inputMap[b] || 0; });
      var tOutputData = tLabels.map(function(b) { return outputMap[b] || 0; });
      destroyChart('tokens');
      chartInstances['tokens'] = new Chart(document.getElementById('tokens-chart'), {
        type: 'bar',
        data: { labels: tLabels, datasets: [
          { label: 'Input', data: tInputData, backgroundColor: '#bc8cff' },
          { label: 'Output', data: tOutputData, backgroundColor: '#79c0ff' }
        ] },
        options: { scales: { y: { beginAtZero: true, stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: { stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Persona Breakdown
      var pLabels = d.persona_breakdown.map(function(p) { return p.agent; });
      var pData = d.persona_breakdown.map(function(p) { return p.count; });
      destroyChart('persona');
      if (pLabels.length > 0) {
        chartInstances['persona'] = new Chart(document.getElementById('persona-chart'), {
          type: 'doughnut',
          data: { labels: pLabels, datasets: [{ data: pData, backgroundColor: CHART_COLORS.slice(0, pLabels.length) }] },
          options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
        });
      }

      // Model Breakdown
      var mdLabels = d.model_breakdown.map(function(m) { return m.model; });
      var mdData = d.model_breakdown.map(function(m) { return m.cost_usd; });
      destroyChart('model');
      if (mdLabels.length > 0) {
        chartInstances['model'] = new Chart(document.getElementById('model-chart'), {
          type: 'doughnut',
          data: { labels: mdLabels, datasets: [{ data: mdData, backgroundColor: CHART_COLORS.slice(0, mdLabels.length) }] },
          options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
        });
      }

      // Token Usage by Project table
      var pt = document.getElementById('project-tokens-table');
      if (d.tokens_by_project.length === 0) {
        pt.innerHTML = '<div class="empty">No token data yet — data appears after new messages are processed</div>';
      } else {
        var ph = '<table><tr><th>Project</th><th>Input Tokens</th><th>Output Tokens</th><th>Cache Read</th><th>Cost</th><th>Messages</th></tr>';
        d.tokens_by_project.forEach(function(p) {
          ph += '<tr><td>' + escapeHtml(p.project_key) + '</td><td>' + fmtTokens(p.input_tokens) + '</td><td>' + fmtTokens(p.output_tokens) + '</td><td>' + fmtTokens(p.cache_read_input_tokens) + '</td><td>' + fmtCost(p.cost_usd) + '</td><td>' + p.message_count + '</td></tr>';
        });
        ph += '</table>';
        pt.innerHTML = ph;
      }

      // Token Usage by Session table
      var st = document.getElementById('session-tokens-table');
      if (d.tokens_by_session.length === 0) {
        st.innerHTML = '<div class="empty">No token data yet</div>';
      } else {
        var sh = '<table><tr><th>Session</th><th>Project</th><th>Input</th><th>Output</th><th>Cost</th><th>Messages</th><th>Duration</th></tr>';
        d.tokens_by_session.forEach(function(s) {
          sh += '<tr><td>' + escapeHtml(s.session_id.slice(0, 12)) + '...</td><td>' + escapeHtml(s.project_key) + '</td><td>' + fmtTokens(s.input_tokens) + '</td><td>' + fmtTokens(s.output_tokens) + '</td><td>' + fmtCost(s.cost_usd) + '</td><td>' + s.message_count + '</td><td>' + fmtDuration(s.duration_ms) + '</td></tr>';
        });
        sh += '</table>';
        st.innerHTML = sh;
      }

      // Cache Efficiency table
      var ct = document.getElementById('cache-table');
      var ce = d.cache_efficiency;
      if (ce.total_input_tokens === 0 && ce.cache_read_tokens === 0) {
        ct.innerHTML = '<div class="empty">No cache data yet</div>';
      } else {
        ct.innerHTML = '<table><tr><th>Total Input Tokens</th><th>Cache Read Tokens</th><th>Hit Ratio</th></tr><tr><td>' + fmtTokens(ce.total_input_tokens) + '</td><td>' + fmtTokens(ce.cache_read_tokens) + '</td><td>' + (ce.cache_hit_ratio * 100).toFixed(1) + '%</td></tr></table>';
      }
    })
    .catch(function(err) {
      console.error('Activity refresh failed:', err);
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
  const eventsPath = options?.pulseEventsPath ?? join(homedir(), '.pulse', 'events', 'mpg-sessions.jsonl');

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

    if (pathname === '/api/activity/summary') {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const range = url.searchParams.get('range') ?? '7d';
      const rangeMs = range === '24h' ? 86_400_000 : range === '30d' ? 2_592_000_000 : 604_800_000;
      const bucket = (range === '24h' ? 'hour' : 'day') as 'hour' | 'day';

      const events = readEvents(eventsPath, rangeMs);
      const body = JSON.stringify({
        summary: computeSummary(events),
        tokens_by_project: tokensByProject(events),
        tokens_by_session: tokensBySession(events),
        sessions_over_time: bucketedCounts(events, 'session_start', bucket),
        messages_over_time: bucketedCounts(events, 'message_routed', bucket),
        cost_over_time: bucketedSums(events, 'message_completed', 'total_cost_usd', bucket),
        input_tokens_over_time: bucketedSums(events, 'message_completed', 'input_tokens', bucket),
        output_tokens_over_time: bucketedSums(events, 'message_completed', 'output_tokens', bucket),
        session_durations: sessionDurations(events),
        model_breakdown: modelBreakdown(events),
        persona_breakdown: personaBreakdown(events),
        cache_efficiency: cacheEfficiency(events),
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
