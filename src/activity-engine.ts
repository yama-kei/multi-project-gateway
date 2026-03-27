import { readFileSync } from 'node:fs';

export interface PulseEvent {
  schema_version: number;
  timestamp: string;
  event_type: string;
  session_id: string;
  project_key: string;
  project_dir: string;
  [key: string]: unknown;
}

export function readEvents(filePath: string, rangeMs: number): PulseEvent[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const cutoff = Date.now() - rangeMs;
  const events: PulseEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as PulseEvent;
      if (new Date(event.timestamp).getTime() >= cutoff) {
        events.push(event);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

export interface SummaryResult {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_sessions: number;
  total_messages: number;
  avg_session_duration_ms: number;
}

export function computeSummary(events: PulseEvent[]): SummaryResult {
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalSessions = 0;
  let totalMessages = 0;
  let totalDuration = 0;
  let durationCount = 0;

  for (const e of events) {
    switch (e.event_type) {
      case 'message_completed':
        totalCost += (e.total_cost_usd as number) || 0;
        totalInput += (e.input_tokens as number) || 0;
        totalOutput += (e.output_tokens as number) || 0;
        break;
      case 'session_start':
        totalSessions++;
        break;
      case 'message_routed':
        totalMessages++;
        break;
      case 'session_end':
      case 'session_idle':
        totalDuration += (e.duration_ms as number) || 0;
        durationCount++;
        break;
    }
  }

  return {
    total_cost_usd: totalCost,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_sessions: totalSessions,
    total_messages: totalMessages,
    avg_session_duration_ms: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
  };
}

export interface ProjectTokens {
  project_key: string;
  project_dir: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  message_count: number;
}

export function tokensByProject(events: PulseEvent[]): ProjectTokens[] {
  const map = new Map<string, ProjectTokens>();
  for (const e of events) {
    if (e.event_type !== 'message_completed') continue;
    const key = e.project_key;
    let entry = map.get(key);
    if (!entry) {
      entry = { project_key: key, project_dir: e.project_dir, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0, message_count: 0 };
      map.set(key, entry);
    }
    entry.input_tokens += (e.input_tokens as number) || 0;
    entry.output_tokens += (e.output_tokens as number) || 0;
    entry.cache_read_input_tokens += (e.cache_read_input_tokens as number) || 0;
    entry.cost_usd += (e.total_cost_usd as number) || 0;
    entry.message_count++;
  }
  return [...map.values()];
}

export interface SessionTokens {
  session_id: string;
  project_key: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  message_count: number;
  duration_ms: number;
}

export function tokensBySession(events: PulseEvent[]): SessionTokens[] {
  const map = new Map<string, SessionTokens>();
  for (const e of events) {
    if (e.event_type !== 'message_completed') continue;
    const key = e.session_id;
    let entry = map.get(key);
    if (!entry) {
      entry = { session_id: key, project_key: e.project_key, input_tokens: 0, output_tokens: 0, cost_usd: 0, message_count: 0, duration_ms: 0 };
      map.set(key, entry);
    }
    entry.input_tokens += (e.input_tokens as number) || 0;
    entry.output_tokens += (e.output_tokens as number) || 0;
    entry.cost_usd += (e.total_cost_usd as number) || 0;
    entry.duration_ms += (e.duration_ms as number) || 0;
    entry.message_count++;
  }
  return [...map.values()];
}

export interface BucketEntry {
  bucket: string;
  value: number;
}

function toBucketKey(timestamp: string, bucket: 'hour' | 'day'): string {
  const d = new Date(timestamp);
  if (bucket === 'hour') {
    return d.getUTCHours().toString().padStart(2, '0') + ':00';
  }
  return (d.getUTCMonth() + 1).toString().padStart(2, '0') + '-' + d.getUTCDate().toString().padStart(2, '0');
}

export function bucketedCounts(events: PulseEvent[], eventType: string, bucket: 'hour' | 'day'): BucketEntry[] {
  const map = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== eventType) continue;
    const key = toBucketKey(e.timestamp, bucket);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([bucket, value]) => ({ bucket, value })).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export function bucketedSums(events: PulseEvent[], eventType: string, field: string, bucket: 'hour' | 'day'): BucketEntry[] {
  const map = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== eventType) continue;
    const key = toBucketKey(e.timestamp, bucket);
    map.set(key, (map.get(key) ?? 0) + ((e[field] as number) || 0));
  }
  return [...map.entries()].map(([bucket, value]) => ({ bucket, value })).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export interface SessionDuration {
  session_id: string;
  project_key: string;
  duration_ms: number;
}

export function sessionDurations(events: PulseEvent[]): SessionDuration[] {
  return events
    .filter(e => e.event_type === 'session_end' || e.event_type === 'session_idle')
    .map(e => ({
      session_id: e.session_id,
      project_key: e.project_key,
      duration_ms: (e.duration_ms as number) || 0,
    }));
}

export interface ModelEntry {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function modelBreakdown(events: PulseEvent[]): ModelEntry[] {
  const map = new Map<string, ModelEntry>();
  for (const e of events) {
    if (e.event_type !== 'message_completed' || !e.model) continue;
    const key = e.model as string;
    let entry = map.get(key);
    if (!entry) {
      entry = { model: key, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      map.set(key, entry);
    }
    entry.input_tokens += (e.input_tokens as number) || 0;
    entry.output_tokens += (e.output_tokens as number) || 0;
    entry.cost_usd += (e.total_cost_usd as number) || 0;
  }
  return [...map.values()];
}

export interface PersonaEntry {
  agent: string;
  count: number;
}

export function personaBreakdown(events: PulseEvent[]): PersonaEntry[] {
  const map = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== 'message_routed') continue;
    const agent = (e.agent_target as string) || 'default';
    map.set(agent, (map.get(agent) ?? 0) + 1);
  }
  return [...map.entries()].map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count);
}

export interface CacheEfficiencyResult {
  total_input_tokens: number;
  cache_read_tokens: number;
  cache_hit_ratio: number;
}

export function cacheEfficiency(events: PulseEvent[]): CacheEfficiencyResult {
  let totalInput = 0;
  let cacheRead = 0;
  for (const e of events) {
    if (e.event_type !== 'message_completed') continue;
    totalInput += (e.input_tokens as number) || 0;
    cacheRead += (e.cache_read_input_tokens as number) || 0;
  }
  const total = totalInput + cacheRead;
  return {
    total_input_tokens: totalInput,
    cache_read_tokens: cacheRead,
    cache_hit_ratio: total > 0 ? cacheRead / total : 0,
  };
}
