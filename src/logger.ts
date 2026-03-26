export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  project?: string;
  session?: string;
}

export interface Logger {
  debug(message: string, ctx?: { project?: string; session?: string }): void;
  info(message: string, ctx?: { project?: string; session?: string }): void;
  warn(message: string, ctx?: { project?: string; session?: string }): void;
  error(message: string, ctx?: { project?: string; session?: string }): void;
}

export function shouldLog(entryLevel: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[entryLevel] >= LEVEL_ORDER[minLevel];
}

export function formatLogEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

export function parseLogEntry(line: string): LogEntry | null {
  try {
    const parsed = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.timestamp === 'string' &&
      typeof parsed.level === 'string' &&
      typeof parsed.message === 'string' &&
      parsed.level in LEVEL_ORDER
    ) {
      return parsed as LogEntry;
    }
    return null;
  } catch {
    return null;
  }
}

export function filterLogEntries(
  entries: LogEntry[],
  opts?: { project?: string; level?: LogLevel },
): LogEntry[] {
  return entries.filter((entry) => {
    if (opts?.level && !shouldLog(entry.level, opts.level)) {
      return false;
    }
    if (opts?.project && entry.project !== opts.project) {
      return false;
    }
    return true;
  });
}

export function createLogger(
  minLevel: LogLevel = 'info',
  writer: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  function log(level: LogLevel, message: string, ctx?: { project?: string; session?: string }): void {
    if (!shouldLog(level, minLevel)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(ctx?.project && { project: ctx.project }),
      ...(ctx?.session && { session: ctx.session }),
    };

    writer(formatLogEntry(entry));
  }

  return {
    debug: (message, ctx) => log('debug', message, ctx),
    info: (message, ctx) => log('info', message, ctx),
    warn: (message, ctx) => log('warn', message, ctx),
    error: (message, ctx) => log('error', message, ctx),
  };
}

export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LEVEL_ORDER;
}
