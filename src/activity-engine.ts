import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type TimeRange = '24h' | '7d' | '30d';
export type Bucket = 'hour' | 'day';

const DEFAULT_PATH = join(homedir(), '.pulse', 'events', 'mpg-sessions.jsonl');

const RANGE_MS: Record<TimeRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface PulseEvent {
  schema_version?: number;
  timestamp: string;
  event_type: string;
  session_id: string;
  project_key: string;
  project_dir: string;
  [key: string]: unknown;
}

function readEvents(filePath: string, range: TimeRange): PulseEvent[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    const cutoff = Date.now() - RANGE_MS[range];
    const events: PulseEvent[] = [];
    for (const line of content.split('\n')) {
      try {
        const e = JSON.parse(line) as PulseEvent;
        if (new Date(e.timestamp).getTime() >= cutoff) {
          events.push(e);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

function bucketKey(timestamp: string, bucket: Bucket): string {
  const d = new Date(timestamp);
  if (bucket === 'hour') {
    d.setMinutes(0, 0, 0);
  } else {
    d.setHours(0, 0, 0, 0);
  }
  return d.toISOString();
}

export interface ActivityEngine {
  computeSummary(range: TimeRange): {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_sessions: number;
    total_messages: number;
    avg_session_duration_ms: number;
  };
  tokensByProject(range: TimeRange): Array<{
    project_key: string;
    project_dir: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cost_usd: number;
    message_count: number;
  }>;
  tokensBySession(range: TimeRange): Array<{
    session_id: string;
    project_key: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    message_count: number;
    duration_ms: number;
  }>;
  bucketed(range: TimeRange, bucket: Bucket, eventType: string, valueField?: string): Array<{ bucket: string; value: number }>;
  sessionDurations(range: TimeRange): Array<{
    session_id: string;
    project_key: string;
    duration_ms: number;
  }>;
  modelBreakdown(range: TimeRange): Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
  personaBreakdown(range: TimeRange): Array<{
    agent: string;
    count: number;
  }>;
  cacheEfficiency(range: TimeRange): {
    total_input_tokens: number;
    cache_read_tokens: number;
    cache_hit_ratio: number;
  };
}

export function createActivityEngine(filePath?: string): ActivityEngine {
  const target = filePath ?? DEFAULT_PATH;

  function getEvents(range: TimeRange, eventType?: string): PulseEvent[] {
    const events = readEvents(target, range);
    return eventType ? events.filter(e => e.event_type === eventType) : events;
  }

  return {
    computeSummary(range) {
      const events = readEvents(target, range);
      const sessions = events.filter(e => e.event_type === 'session_start');
      const messages = events.filter(e => e.event_type === 'message_completed');
      const endings = events.filter(e => e.event_type === 'session_end' || e.event_type === 'session_idle');

      const totalDuration = endings.reduce((s, e) => s + (Number(e.duration_ms) || 0), 0);

      return {
        total_cost_usd: messages.reduce((s, e) => s + (Number(e.total_cost_usd) || 0), 0),
        total_input_tokens: messages.reduce((s, e) => s + (Number(e.input_tokens) || 0), 0),
        total_output_tokens: messages.reduce((s, e) => s + (Number(e.output_tokens) || 0), 0),
        total_sessions: sessions.length,
        total_messages: messages.length,
        avg_session_duration_ms: endings.length > 0 ? totalDuration / endings.length : 0,
      };
    },

    tokensByProject(range) {
      const messages = getEvents(range, 'message_completed');
      const map = new Map<string, { project_key: string; project_dir: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cost_usd: number; message_count: number }>();
      for (const e of messages) {
        const key = e.project_key;
        const row = map.get(key) ?? { project_key: key, project_dir: e.project_dir, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0, message_count: 0 };
        row.input_tokens += Number(e.input_tokens) || 0;
        row.output_tokens += Number(e.output_tokens) || 0;
        row.cache_read_input_tokens += Number(e.cache_read_input_tokens) || 0;
        row.cost_usd += Number(e.total_cost_usd) || 0;
        row.message_count++;
        map.set(key, row);
      }
      return Array.from(map.values());
    },

    tokensBySession(range) {
      const messages = getEvents(range, 'message_completed');
      const map = new Map<string, { session_id: string; project_key: string; input_tokens: number; output_tokens: number; cost_usd: number; message_count: number; duration_ms: number }>();
      for (const e of messages) {
        const key = e.session_id;
        const row = map.get(key) ?? { session_id: key, project_key: e.project_key, input_tokens: 0, output_tokens: 0, cost_usd: 0, message_count: 0, duration_ms: 0 };
        row.input_tokens += Number(e.input_tokens) || 0;
        row.output_tokens += Number(e.output_tokens) || 0;
        row.cost_usd += Number(e.total_cost_usd) || 0;
        row.duration_ms += Number(e.duration_ms) || 0;
        row.message_count++;
        map.set(key, row);
      }
      return Array.from(map.values());
    },

    bucketed(range, bucket, eventType, valueField) {
      const events = getEvents(range, eventType);
      const map = new Map<string, number>();
      for (const e of events) {
        const key = bucketKey(e.timestamp, bucket);
        const val = valueField ? (Number(e[valueField]) || 0) : 1;
        map.set(key, (map.get(key) ?? 0) + val);
      }
      return Array.from(map.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([b, value]) => ({ bucket: b, value }));
    },

    sessionDurations(range) {
      const endings = getEvents(range).filter(e => e.event_type === 'session_end' || e.event_type === 'session_idle');
      return endings.map(e => ({
        session_id: e.session_id,
        project_key: e.project_key,
        duration_ms: Number(e.duration_ms) || 0,
      }));
    },

    modelBreakdown(range) {
      const messages = getEvents(range, 'message_completed');
      const map = new Map<string, { model: string; input_tokens: number; output_tokens: number; cost_usd: number }>();
      for (const e of messages) {
        const model = String(e.model ?? 'unknown');
        const row = map.get(model) ?? { model, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
        row.input_tokens += Number(e.input_tokens) || 0;
        row.output_tokens += Number(e.output_tokens) || 0;
        row.cost_usd += Number(e.total_cost_usd) || 0;
        map.set(model, row);
      }
      return Array.from(map.values());
    },

    personaBreakdown(range) {
      const routed = getEvents(range, 'message_routed');
      const map = new Map<string, number>();
      for (const e of routed) {
        const agent = String(e.agent_target ?? 'default');
        map.set(agent, (map.get(agent) ?? 0) + 1);
      }
      return Array.from(map.entries()).map(([agent, count]) => ({ agent, count }));
    },

    cacheEfficiency(range) {
      const messages = getEvents(range, 'message_completed');
      const totalInput = messages.reduce((s, e) => s + (Number(e.input_tokens) || 0), 0);
      const cacheRead = messages.reduce((s, e) => s + (Number(e.cache_read_input_tokens) || 0), 0);
      const denominator = cacheRead + totalInput;
      return {
        total_input_tokens: totalInput,
        cache_read_tokens: cacheRead,
        cache_hit_ratio: denominator > 0 ? cacheRead / denominator : 0,
      };
    },
  };
}
