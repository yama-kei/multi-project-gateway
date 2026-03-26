import { describe, it, expect, vi } from 'vitest';
import {
  createLogger,
  shouldLog,
  formatLogEntry,
  parseLogEntry,
  filterLogEntries,
  isValidLogLevel,
  type LogEntry,
  type LogLevel,
} from '../src/logger.js';

describe('shouldLog', () => {
  it('allows same level', () => {
    expect(shouldLog('info', 'info')).toBe(true);
  });

  it('allows higher level', () => {
    expect(shouldLog('error', 'info')).toBe(true);
    expect(shouldLog('warn', 'debug')).toBe(true);
  });

  it('blocks lower level', () => {
    expect(shouldLog('debug', 'info')).toBe(false);
    expect(shouldLog('info', 'warn')).toBe(false);
  });

  it('debug allows all levels', () => {
    expect(shouldLog('debug', 'debug')).toBe(true);
    expect(shouldLog('info', 'debug')).toBe(true);
    expect(shouldLog('warn', 'debug')).toBe(true);
    expect(shouldLog('error', 'debug')).toBe(true);
  });

  it('error only allows error', () => {
    expect(shouldLog('debug', 'error')).toBe(false);
    expect(shouldLog('info', 'error')).toBe(false);
    expect(shouldLog('warn', 'error')).toBe(false);
    expect(shouldLog('error', 'error')).toBe(true);
  });
});

describe('formatLogEntry', () => {
  it('produces valid JSON', () => {
    const entry: LogEntry = {
      timestamp: '2026-03-25T12:00:00.000Z',
      level: 'info',
      message: 'test message',
    };
    const json = formatLogEntry(entry);
    const parsed = JSON.parse(json);
    expect(parsed.timestamp).toBe('2026-03-25T12:00:00.000Z');
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('test message');
  });

  it('includes optional project and session fields', () => {
    const entry: LogEntry = {
      timestamp: '2026-03-25T12:00:00.000Z',
      level: 'warn',
      message: 'test',
      project: 'my-app',
      session: 'abc123',
    };
    const parsed = JSON.parse(formatLogEntry(entry));
    expect(parsed.project).toBe('my-app');
    expect(parsed.session).toBe('abc123');
  });
});

describe('parseLogEntry', () => {
  it('parses valid JSON log entry', () => {
    const line = '{"timestamp":"2026-03-25T12:00:00.000Z","level":"info","message":"hello"}';
    const entry = parseLogEntry(line);
    expect(entry).not.toBeNull();
    expect(entry!.level).toBe('info');
    expect(entry!.message).toBe('hello');
  });

  it('returns null for invalid JSON', () => {
    expect(parseLogEntry('not json')).toBeNull();
  });

  it('returns null for JSON missing required fields', () => {
    expect(parseLogEntry('{"level":"info"}')).toBeNull();
    expect(parseLogEntry('{"timestamp":"x","message":"y"}')).toBeNull();
    expect(parseLogEntry('{"timestamp":"x","level":"info"}')).toBeNull();
  });

  it('returns null for invalid log level', () => {
    expect(parseLogEntry('{"timestamp":"x","level":"trace","message":"y"}')).toBeNull();
  });

  it('preserves optional fields', () => {
    const line = '{"timestamp":"t","level":"debug","message":"m","project":"p","session":"s"}';
    const entry = parseLogEntry(line);
    expect(entry!.project).toBe('p');
    expect(entry!.session).toBe('s');
  });
});

describe('filterLogEntries', () => {
  const entries: LogEntry[] = [
    { timestamp: 't1', level: 'debug', message: 'debug msg', project: 'alpha' },
    { timestamp: 't2', level: 'info', message: 'info msg', project: 'beta' },
    { timestamp: 't3', level: 'warn', message: 'warn msg', project: 'alpha' },
    { timestamp: 't4', level: 'error', message: 'error msg', project: 'beta' },
  ];

  it('returns all entries with no filters', () => {
    expect(filterLogEntries(entries)).toHaveLength(4);
  });

  it('filters by minimum level', () => {
    const result = filterLogEntries(entries, { level: 'warn' });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('filters by project name', () => {
    const result = filterLogEntries(entries, { project: 'alpha' });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.project === 'alpha')).toBe(true);
  });

  it('combines level and project filters', () => {
    const result = filterLogEntries(entries, { project: 'beta', level: 'error' });
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('error msg');
  });

  it('returns empty array when nothing matches', () => {
    const result = filterLogEntries(entries, { project: 'nonexistent' });
    expect(result).toHaveLength(0);
  });
});

describe('isValidLogLevel', () => {
  it('accepts valid levels', () => {
    expect(isValidLogLevel('debug')).toBe(true);
    expect(isValidLogLevel('info')).toBe(true);
    expect(isValidLogLevel('warn')).toBe(true);
    expect(isValidLogLevel('error')).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(isValidLogLevel('trace')).toBe(false);
    expect(isValidLogLevel('verbose')).toBe(false);
    expect(isValidLogLevel('')).toBe(false);
    expect(isValidLogLevel(42)).toBe(false);
    expect(isValidLogLevel(null)).toBe(false);
  });
});

describe('createLogger', () => {
  it('writes JSON log lines', () => {
    const lines: string[] = [];
    const logger = createLogger('debug', (line) => lines.push(line));

    logger.info('test message');

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('test message');
    expect(entry.timestamp).toBeDefined();
  });

  it('respects minimum log level', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (line) => lines.push(line));

    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('visible');
    logger.error('visible');

    expect(lines).toHaveLength(2);
  });

  it('includes project and session context', () => {
    const lines: string[] = [];
    const logger = createLogger('debug', (line) => lines.push(line));

    logger.info('connected', { project: 'my-app', session: 'sess-123' });

    const entry = JSON.parse(lines[0]);
    expect(entry.project).toBe('my-app');
    expect(entry.session).toBe('sess-123');
  });

  it('omits project/session when not provided', () => {
    const lines: string[] = [];
    const logger = createLogger('debug', (line) => lines.push(line));

    logger.info('plain message');

    const entry = JSON.parse(lines[0]);
    expect(entry.project).toBeUndefined();
    expect(entry.session).toBeUndefined();
  });

  it('defaults to info level', () => {
    const lines: string[] = [];
    const logger = createLogger(undefined, (line) => lines.push(line));

    logger.debug('hidden');
    logger.info('visible');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe('info');
  });
});
