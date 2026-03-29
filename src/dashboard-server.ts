import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { SessionManager } from './session-manager.js';
import type { DiscordBot } from './discord.js';
import type { GatewayConfig } from './config.js';
import type { ActivityEngine, TimeRange, Bucket } from './activity-engine.js';

export interface DashboardServer {
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

export interface DashboardServerOptions {
  activityEngine?: ActivityEngine;
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
  .summary-cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 24px; }
  .summary-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
  .summary-value { font-size: 24px; font-weight: bold; color: #e1e4e8; }
  .summary-label { font-size: 12px; color: #8b949e; margin-top: 4px; }
</style>
</head>
<body>
<h1>Multi-Project Gateway</h1>
<p class="subtitle" id="version"></p>
<div class="tabs">
  <button class="tab active" onclick="switchTab('overview')">Overview</button>
  <button class="tab" onclick="switchTab('activity')">Activity</button>
  <button class="tab" onclick="switchTab('timeline')">Timeline</button>
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
  <div class="summary-cards">
    <div class="summary-card"><div class="summary-value" id="total-cost">$0.00</div><div class="summary-label">Total Cost</div></div>
    <div class="summary-card"><div class="summary-value" id="total-tokens">0</div><div class="summary-label">Total Tokens</div></div>
    <div class="summary-card"><div class="summary-value" id="total-sessions-card">0</div><div class="summary-label">Sessions</div></div>
    <div class="summary-card"><div class="summary-value" id="total-messages">0</div><div class="summary-label">Messages</div></div>
    <div class="summary-card"><div class="summary-value" id="avg-duration">0m</div><div class="summary-label">Avg Duration</div></div>
  </div>
  <div class="chart-grid">
    <div class="chart-card"><h3>Messages Over Time</h3><canvas id="messages-chart"></canvas></div>
    <div class="chart-card"><h3>Cost Over Time</h3><canvas id="cost-chart"></canvas></div>
    <div class="chart-card"><h3>Sessions Over Time</h3><canvas id="sessions-chart"></canvas></div>
    <div class="chart-card"><h3>Token Usage Over Time (Input / Output)</h3><canvas id="tokens-chart"></canvas></div>
    <div class="chart-card"><h3>Cache Read Tokens Over Time</h3><canvas id="cache-chart-time"></canvas></div>
    <div class="chart-card"><h3>Persona Breakdown</h3><canvas id="persona-chart"></canvas></div>
    <div class="chart-card"><h3>Model Breakdown</h3><canvas id="model-chart"></canvas></div>
  </div>
  <h3 style="margin:16px 0 8px">Token Usage by Project</h3>
  <div id="project-table"></div>
  <h3 style="margin:16px 0 8px">Token Usage by Session</h3>
  <div id="session-table"></div>
  <h3 style="margin:16px 0 8px">Cache Efficiency</h3>
  <div id="cache-table"></div>
</div>

<div id="tab-timeline" style="display:none">
  <div class="range-selector timeline-range">
    <button class="tl-range-btn range-btn active" data-range="24h">24h</button>
    <button class="tl-range-btn range-btn" data-range="7d">7d</button>
    <button class="tl-range-btn range-btn" data-range="30d">30d</button>
  </div>
  <div class="chart-card"><h3>Session Timeline</h3><canvas id="timeline-chart"></canvas></div>
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
function formatDuration(startTs) {
  var diff = Math.floor((Date.now() - startTs) / 1000);
  if (diff < 60) return diff + 's';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  var h = Math.floor(diff / 3600);
  var m = Math.floor((diff % 3600) / 60);
  return h + 'h ' + m + 'm';
}
function sessionStatus(s) {
  if (s.processing) return '<span style="color:#3fb950">processing</span>';
  if (s.queueLength > 0) return '<span style="color:#d29922">waiting</span>';
  return '<span style="color:#8b949e">idle</span>';
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
function compactTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function formatLocalTime(isoStr, isHourBucket) {
  var d = new Date(isoStr);
  if (isHourBucket) return String(d.getHours()).padStart(2, '0') + ':00';
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[d.getMonth()] + ' ' + d.getDate();
}
function resolveProjectName(key, nameMap) {
  if (!key) return '—';
  var parts = key.split(':');
  var channelId = parts[0];
  var agent = parts.length > 1 ? parts[1] : null;
  var name = (nameMap && nameMap[channelId]) ? nameMap[channelId] : channelId;
  return agent ? name + ':' + agent : name;
}
function copyToClipboard(text, el) {
  navigator.clipboard.writeText(text).then(function() {
    var orig = el.textContent;
    el.textContent = 'copied!';
    el.style.color = '#3fb950';
    setTimeout(function() { el.textContent = orig; el.style.color = ''; }, 1200);
  });
}

var projectNameMap = {};

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

      // Build name map from projects list
      if (d.projects) {
        d.projects.forEach(function(p) {
          if (p.channelId && p.name) projectNameMap[p.channelId] = p.name;
        });
      }

      // Sessions table — sort by most recent last activity first
      d.sessions.sort(function(a, b) {
        return (b.lastActivity || 0) - (a.lastActivity || 0);
      });
      var st = document.getElementById('sessions-table');
      if (d.sessions.length === 0) {
        st.innerHTML = '<div class="empty">No active sessions</div>';
      } else {
        var h = '<table><tr><th>Session</th><th>Status</th><th>Duration</th><th>Last Activity</th></tr>';
        for (var i = 0; i < d.sessions.length; i++) {
          var s = d.sessions[i];
          var sid = s.sessionId || '';
          var shortId = sid ? sid.slice(0, 8) : '';
          var pkParts = (s.projectKey || '').split(':');
          var projName = (projectNameMap && projectNameMap[pkParts[0]]) ? projectNameMap[pkParts[0]] : pkParts[0];
          var role = pkParts.length > 1 ? pkParts[1] : '';
          var sessionLabel = projName && shortId ? (role ? projName + '/' + shortId + '/' + role : projName + '/' + shortId) : (shortId || '—');
          h += '<tr><td><span class="clickable-id" style="cursor:pointer;text-decoration:underline dotted" title="Click to copy: ' + escapeHtml(sid) + '" onclick="copyToClipboard(\\'' + escapeHtml(sid) + '\\', this)">' + escapeHtml(sessionLabel) + '</span></td><td>' + sessionStatus(s) + '</td><td>' + formatDuration(s.createdAt) + '</td><td>' + formatAgo(s.lastActivity) + '</td></tr>';
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
var timelineRange = '24h';
var CHART_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#79c0ff'];

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(t) {
    if (t.textContent.toLowerCase() === tab) t.classList.add('active');
  });
  document.getElementById('tab-overview').style.display = tab === 'overview' ? '' : 'none';
  document.getElementById('tab-activity').style.display = tab === 'activity' ? '' : 'none';
  document.getElementById('tab-timeline').style.display = tab === 'timeline' ? '' : 'none';
  if (tab === 'activity') refreshActivity();
  if (tab === 'timeline') refreshTimeline();
}

document.querySelectorAll('#tab-activity .range-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('#tab-activity .range-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    refreshActivity();
  });
});

document.querySelectorAll('.tl-range-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.tl-range-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    timelineRange = btn.dataset.range;
    refreshTimeline();
  });
});

function destroyChart(key) {
  if (chartInstances[key]) { chartInstances[key].destroy(); chartInstances[key] = null; }
}

function timeAxisOptions(isHourBucket) {
  return {
    ticks: {
      color: '#8b949e',
      callback: function(value, index, ticks) {
        var label = this.getLabelForValue(value);
        return formatLocalTime(label, isHourBucket);
      }
    },
    grid: { color: '#30363d' }
  };
}

function formatSegmentDuration(startIso, endIso) {
  var ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return ms + 'ms';
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  s = s % 60;
  if (m < 60) return m + 'm ' + s + 's';
  var h = Math.floor(m / 60);
  m = m % 60;
  return h + 'h ' + m + 'm';
}

function refreshTimeline() {
  var RANGE_MS = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
  var now = Date.now();
  var rangeMs = RANGE_MS[timelineRange] || RANGE_MS['24h'];
  var xMin = now - rangeMs;
  var xMax = now;

  fetch('/api/activity/timeline?range=' + timelineRange)
    .then(function(r) { return r.json(); })
    .then(function(sessions) {
      destroyChart('timeline');
      if (!sessions || sessions.length === 0) {
        var ctx = document.getElementById('timeline-chart');
        chartInstances['timeline'] = new Chart(ctx, {
          type: 'bar',
          data: { labels: [], datasets: [] },
          options: { indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: 'No session data', color: '#8b949e' } } }
        });
        return;
      }
      // Only show sessions that had processing activity (idle-only rows aren't useful)
      var visibleSessions = sessions.filter(function(s) {
        return s.segments.some(function(seg) {
          if (seg.state !== 'processing') return false;
          var start = Math.max(new Date(seg.start).getTime(), xMin);
          var end = Math.min(new Date(seg.end).getTime(), xMax);
          return end > start;
        });
      });
      if (visibleSessions.length === 0) {
        var ctx = document.getElementById('timeline-chart');
        chartInstances['timeline'] = new Chart(ctx, {
          type: 'bar',
          data: { labels: [], datasets: [] },
          options: { indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: 'No active sessions in range', color: '#8b949e' } } }
        });
        return;
      }
      var labels = visibleSessions.map(function(s) { return s.label; });

      // Set canvas height BEFORE creating chart to avoid visual expansion
      var canvas = document.getElementById('timeline-chart');
      var ROW_H = 24;
      var minH = Math.max(120, visibleSessions.length * ROW_H + 60);
      canvas.parentElement.style.minHeight = minH + 'px';
      canvas.style.height = minH + 'px';

      // Single dummy dataset for y-axis labels; custom plugin draws the real bars
      var dummyData = visibleSessions.map(function() { return [xMin, xMin]; });
      var timelinePlugin = {
        id: 'timelineSegments',
        afterDatasetsDraw: function(chart) {
          var ctx = chart.ctx;
          var yScale = chart.scales.y;
          var xScale = chart.scales.x;
          var barH = Math.max(6, Math.min(16, yScale.height / visibleSessions.length * 0.65));
          visibleSessions.forEach(function(session, i) {
            var yCenter = yScale.getPixelForValue(i);
            session.segments.forEach(function(seg) {
              var start = Math.max(new Date(seg.start).getTime(), xMin);
              var end = Math.min(new Date(seg.end).getTime(), xMax);
              if (start >= end) return;
              var x1 = xScale.getPixelForValue(start);
              var x2 = xScale.getPixelForValue(end);
              var w = Math.max(x2 - x1, 2);
              ctx.fillStyle = seg.state === 'processing' ? '#3fb950' : '#484f58';
              ctx.fillRect(x1, yCenter - barH / 2, w, barH);
            });
          });
        }
      };

      chartInstances['timeline'] = new Chart(canvas, {
        type: 'bar',
        data: { labels: labels, datasets: [{ data: dummyData, backgroundColor: 'transparent', borderWidth: 0, barThickness: 1 }] },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          scales: {
            x: {
              type: 'linear',
              position: 'top',
              min: xMin,
              max: xMax,
              ticks: {
                color: '#8b949e',
                callback: function(value) {
                  var d = new Date(value);
                  var hh = String(d.getHours()).padStart(2, '0');
                  var mm = String(d.getMinutes()).padStart(2, '0');
                  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                  return months[d.getMonth()] + ' ' + d.getDate() + ' ' + hh + ':' + mm;
                }
              },
              grid: { color: '#30363d' }
            },
            y: {
              ticks: { color: '#8b949e', font: { family: 'monospace', size: 11 } },
              grid: { display: false }
            }
          },
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false }
          }
        },
        plugins: [timelinePlugin]
      });
    })
    .catch(function(err) { console.error('Timeline fetch error:', err); });
}

function refreshActivity() {
  var isHourBucket = currentRange === '24h';
  fetch('/api/activity/summary?range=' + currentRange)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var nameMap = d.project_name_map || {};
      // Merge into global map
      Object.keys(nameMap).forEach(function(k) { projectNameMap[k] = nameMap[k]; });

      // Summary cards
      var s = d.summary;
      document.getElementById('total-cost').textContent = '$' + s.total_cost_usd.toFixed(2);
      var totalTok = s.total_input_tokens + s.total_output_tokens;
      document.getElementById('total-tokens').textContent = compactTokens(totalTok);
      document.getElementById('total-sessions-card').textContent = String(s.total_sessions);
      document.getElementById('total-messages').textContent = String(s.total_messages);
      document.getElementById('avg-duration').textContent = Math.round(s.avg_session_duration_ms / 60000) + 'm';

      var xOpts = timeAxisOptions(isHourBucket);

      // Messages Over Time (line)
      destroyChart('messages');
      chartInstances['messages'] = new Chart(document.getElementById('messages-chart'), {
        type: 'line',
        data: { labels: d.messages_over_time.map(function(e) { return e.bucket; }), datasets: [{ label: 'Messages', data: d.messages_over_time.map(function(e) { return e.value; }), borderColor: '#58a6ff', tension: 0.3 }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: xOpts }, plugins: { legend: { display: false } } }
      });

      // Cost Over Time (line)
      destroyChart('cost');
      chartInstances['cost'] = new Chart(document.getElementById('cost-chart'), {
        type: 'line',
        data: { labels: d.cost_over_time.map(function(e) { return e.bucket; }), datasets: [{ label: 'Cost ($)', data: d.cost_over_time.map(function(e) { return e.value; }), borderColor: '#3fb950', tension: 0.3 }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: xOpts }, plugins: { legend: { display: false } } }
      });

      // Sessions Over Time (line)
      destroyChart('sessions');
      chartInstances['sessions'] = new Chart(document.getElementById('sessions-chart'), {
        type: 'line',
        data: { labels: d.sessions_over_time.map(function(e) { return e.bucket; }), datasets: [{ label: 'Sessions', data: d.sessions_over_time.map(function(e) { return e.value; }), borderColor: '#d29922', tension: 0.3 }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#30363d' } }, x: xOpts }, plugins: { legend: { display: false } } }
      });

      // Token Usage Over Time — Input + Output stacked (NO cache reads)
      var allBuckets = {};
      (d.input_tokens_over_time || []).forEach(function(e) { allBuckets[e.bucket] = true; });
      (d.output_tokens_over_time || []).forEach(function(e) { allBuckets[e.bucket] = true; });
      var bucketKeys = Object.keys(allBuckets).sort();
      var inputMap = {}; (d.input_tokens_over_time || []).forEach(function(e) { inputMap[e.bucket] = e.value; });
      var outputMap = {}; (d.output_tokens_over_time || []).forEach(function(e) { outputMap[e.bucket] = e.value; });
      destroyChart('tokens');
      chartInstances['tokens'] = new Chart(document.getElementById('tokens-chart'), {
        type: 'bar',
        data: {
          labels: bucketKeys,
          datasets: [
            { label: 'Input', data: bucketKeys.map(function(k) { return inputMap[k] || 0; }), backgroundColor: '#58a6ff' },
            { label: 'Output', data: bucketKeys.map(function(k) { return outputMap[k] || 0; }), backgroundColor: '#3fb950' }
          ]
        },
        options: { scales: { y: { beginAtZero: true, stacked: true, ticks: { color: '#8b949e', callback: function(v) { return compactTokens(v); } }, grid: { color: '#30363d' } }, x: Object.assign({}, xOpts, { stacked: true }) }, plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Cache Read Tokens Over Time — separate chart
      destroyChart('cache-time');
      chartInstances['cache-time'] = new Chart(document.getElementById('cache-chart-time'), {
        type: 'bar',
        data: { labels: (d.cache_read_over_time || []).map(function(e) { return e.bucket; }), datasets: [{ label: 'Cache Read', data: (d.cache_read_over_time || []).map(function(e) { return e.value; }), backgroundColor: '#bc8cff' }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e', callback: function(v) { return compactTokens(v); } }, grid: { color: '#30363d' } }, x: xOpts }, plugins: { legend: { display: false } } }
      });

      // Persona Breakdown (doughnut)
      destroyChart('persona');
      if (d.persona_breakdown.length > 0) {
        chartInstances['persona'] = new Chart(document.getElementById('persona-chart'), {
          type: 'doughnut',
          data: { labels: d.persona_breakdown.map(function(p) { return p.agent; }), datasets: [{ data: d.persona_breakdown.map(function(p) { return p.count; }), backgroundColor: CHART_COLORS.slice(0, d.persona_breakdown.length) }] },
          options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
        });
      }

      // Model Breakdown (doughnut)
      destroyChart('model');
      if (d.model_breakdown.length > 0) {
        chartInstances['model'] = new Chart(document.getElementById('model-chart'), {
          type: 'doughnut',
          data: { labels: d.model_breakdown.map(function(m) { return m.model; }), datasets: [{ data: d.model_breakdown.map(function(m) { return m.cost_usd; }), backgroundColor: CHART_COLORS.slice(0, d.model_breakdown.length) }] },
          options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
        });
      }

      // Token Usage by Project table — resolve names, compact token notation
      var pt = document.getElementById('project-table');
      if (d.tokens_by_project.length === 0) { pt.innerHTML = '<div class="empty">No data</div>'; }
      else {
        var h = '<table><tr><th>Project</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cost</th><th>Messages</th></tr>';
        d.tokens_by_project.forEach(function(p) { h += '<tr><td>' + escapeHtml(resolveProjectName(p.project_key, nameMap)) + '</td><td>' + compactTokens(p.input_tokens) + '</td><td>' + compactTokens(p.output_tokens) + '</td><td>' + compactTokens(p.cache_read_input_tokens) + '</td><td>$' + p.cost_usd.toFixed(3) + '</td><td>' + p.message_count + '</td></tr>'; });
        pt.innerHTML = h + '</table>';
      }

      // Token Usage by Session table — resolve names, copy-to-clipboard session IDs
      var st = document.getElementById('session-table');
      if (d.tokens_by_session.length === 0) { st.innerHTML = '<div class="empty">No data</div>'; }
      else {
        var h2 = '<table><tr><th>Session</th><th>Project</th><th>Input</th><th>Output</th><th>Cost</th><th>Msgs</th><th>Duration</th></tr>';
        d.tokens_by_session.forEach(function(row) {
          var shortId = row.session_id.substring(0, 8) + '...';
          h2 += '<tr><td><span class="clickable-id" style="cursor:pointer;text-decoration:underline dotted" title="Click to copy: ' + escapeHtml(row.session_id) + '" onclick="copyToClipboard(\\'' + escapeHtml(row.session_id) + '\\', this)">' + escapeHtml(shortId) + '</span></td><td>' + escapeHtml(resolveProjectName(row.project_key, nameMap)) + '</td><td>' + compactTokens(row.input_tokens) + '</td><td>' + compactTokens(row.output_tokens) + '</td><td>$' + row.cost_usd.toFixed(3) + '</td><td>' + row.message_count + '</td><td>' + Math.round(row.duration_ms / 60000) + 'm</td></tr>';
        });
        st.innerHTML = h2 + '</table>';
      }

      // Cache Efficiency table
      var ct = document.getElementById('cache-table');
      var ce = d.cache_efficiency;
      ct.innerHTML = '<table><tr><th>Total Input</th><th>Cache Read</th><th>Hit Ratio</th></tr><tr><td>' + compactTokens(ce.total_input_tokens) + '</td><td>' + compactTokens(ce.cache_read_tokens) + '</td><td>' + (ce.cache_hit_ratio * 100).toFixed(1) + '%</td></tr></table>';
    })
    .catch(function(err) { console.error('Activity fetch error:', err); });
}

setInterval(function() {
  if (document.getElementById('tab-activity').style.display !== 'none') {
    refreshActivity();
  }
  if (document.getElementById('tab-timeline').style.display !== 'none') {
    refreshTimeline();
  }
}, 30000);
</script>
</body>
</html>`;
}

export function createDashboardServer(
  port: number,
  sessionManager: SessionManager,
  bot: DiscordBot,
  config?: GatewayConfig,
  options?: DashboardServerOptions,
): Promise<DashboardServer> {
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

    if (pathname === '/api/activity/timeline') {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const rangeParam = url.searchParams.get('range') || '7d';
      if (rangeParam !== '24h' && rangeParam !== '7d' && rangeParam !== '30d') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid range. Must be 24h, 7d, or 30d' }));
        return;
      }
      const engine = options?.activityEngine;
      if (!engine) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      try {
        const data = engine.sessionTimeline(rangeParam as TimeRange);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to compute timeline data' }));
      }
      return;
    }

    if (pathname === '/api/activity/summary') {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const rangeParam = url.searchParams.get('range') || '7d';
      if (rangeParam !== '24h' && rangeParam !== '7d' && rangeParam !== '30d') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid range. Must be 24h, 7d, or 30d' }));
        return;
      }
      const range: TimeRange = rangeParam;
      const bucket: Bucket = range === '24h' ? 'hour' : 'day';
      const engine = options?.activityEngine;

      if (!engine) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          summary: { total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, total_sessions: 0, total_messages: 0, avg_session_duration_ms: 0 },
          tokens_by_project: [], tokens_by_session: [],
          sessions_over_time: [], messages_over_time: [], cost_over_time: [],
          input_tokens_over_time: [], output_tokens_over_time: [], cache_read_over_time: [],
          session_durations: [], model_breakdown: [], persona_breakdown: [],
          cache_efficiency: { total_input_tokens: 0, cache_read_tokens: 0, cache_hit_ratio: 0 },
          project_name_map: {},
        }));
        return;
      }

      try {
        // Build channel ID → project name map from config
        const projectNameMap: Record<string, string> = {};
        if (config) {
          for (const [channelId, project] of Object.entries(config.projects)) {
            projectNameMap[channelId] = project.name;
          }
        }

        const data = {
          summary: engine.computeSummary(range),
          tokens_by_project: engine.tokensByProject(range),
          tokens_by_session: engine.tokensBySession(range),
          sessions_over_time: engine.bucketed(range, bucket, 'session_start'),
          messages_over_time: engine.bucketed(range, bucket, 'message_completed'),
          cost_over_time: engine.bucketed(range, bucket, 'message_completed', 'total_cost_usd'),
          input_tokens_over_time: engine.bucketed(range, bucket, 'message_completed', 'input_tokens'),
          output_tokens_over_time: engine.bucketed(range, bucket, 'message_completed', 'output_tokens'),
          cache_read_over_time: engine.bucketed(range, bucket, 'message_completed', 'cache_read_input_tokens'),
          session_durations: engine.sessionDurations(range),
          model_breakdown: engine.modelBreakdown(range),
          persona_breakdown: engine.personaBreakdown(range),
          cache_efficiency: engine.cacheEfficiency(range),
          project_name_map: projectNameMap,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to compute activity data' }));
      }
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

  return new Promise<DashboardServer>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      console.log(`Dashboard server listening on http://localhost:${port}/`);
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
