import { mkdirSync, readFileSync, statSync, rmSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeArgs, parseClaudeJsonOutput, friendlyError } from '../claude-cli.js';
import type { AgentRuntime, SpawnOpts } from '../agent-runtime.js';
import type { ClaudeResult } from '../claude-cli.js';
import { createSession, sessionExists, listSessions, killSession, ensureTmux } from '../tmux.js';

const SESSION_PREFIX = 'mpg-';
const OUTPUT_BASE_DIR = '/tmp/mpg-sessions';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const HEALTH_CHECK_DELAY_MS = 2 * 60 * 1000; // 2 minutes
const POLL_INTERVAL_MS = 500;

/** Sanitize a session key for use as a tmux session name. */
function sanitizeSessionName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function outputDir(sessionKey: string): string {
  return join(OUTPUT_BASE_DIR, sanitizeSessionName(sessionKey));
}

function outputFile(sessionKey: string): string {
  return join(outputDir(sessionKey), 'output.json');
}

function stderrFile(sessionKey: string): string {
  return join(outputDir(sessionKey), 'stderr.log');
}

/**
 * tmux-based AgentRuntime that persists Claude sessions across gateway restarts.
 *
 * How it works:
 * 1. spawn() creates a detached tmux session running `claude ... > output.json 2> stderr.log`
 * 2. mpg polls/watches the output file until Claude finishes (file appears and process exits)
 * 3. On gateway restart, listOrphanedSessions() discovers surviving tmux sessions via `tmux ls`
 * 4. reattach() re-reads the output file from a still-running session
 */
export class TmuxRuntime implements AgentRuntime {
  readonly name = 'tmux';
  readonly canResume = true;

  constructor() {
    ensureTmux();
  }

  async spawn(opts: SpawnOpts): Promise<ClaudeResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sessionKey = opts.sessionId ?? `spawn-${Date.now()}`;
    const tmuxName = SESSION_PREFIX + sanitizeSessionName(sessionKey);

    // Prepare output directory
    const outDir = outputDir(sessionKey);
    mkdirSync(outDir, { recursive: true });
    const outPath = outputFile(sessionKey);
    const errPath = stderrFile(sessionKey);

    // Build the claude command
    const args = buildClaudeArgs(opts.baseArgs, opts.prompt, opts.sessionId, opts.systemPrompt);
    const escapedArgs = args.map((a) => shellEscape(a));
    const command = `claude ${escapedArgs.join(' ')} > ${shellEscape(outPath)} 2> ${shellEscape(errPath)}`;

    // Kill any stale session with the same name
    if (sessionExists(tmuxName)) {
      killSession(tmuxName);
    }

    // Launch in tmux
    createSession(tmuxName, command, { cwd: opts.cwd });

    // Wait for Claude to finish by polling for tmux session exit + output file
    return this._waitForResult(tmuxName, sessionKey, outPath, errPath, timeoutMs);
  }

  async listOrphanedSessions(): Promise<string[]> {
    const sessions = listSessions(SESSION_PREFIX);
    return sessions.map((name) => name.slice(SESSION_PREFIX.length));
  }

  async reattach(sessionKey: string): Promise<ClaudeResult> {
    const tmuxName = SESSION_PREFIX + sanitizeSessionName(sessionKey);
    const outPath = outputFile(sessionKey);
    const errPath = stderrFile(sessionKey);

    if (!sessionExists(tmuxName)) {
      // Session already finished — try to read its output
      if (existsSync(outPath)) {
        return this._readResult(outPath, errPath);
      }
      throw new Error(`tmux session ${tmuxName} does not exist and no output file found`);
    }

    // Session is still running — wait for it
    return this._waitForResult(tmuxName, sessionKey, outPath, errPath, DEFAULT_TIMEOUT_MS);
  }

  /** Clean up tmux session and temp files for a given session key. */
  cleanup(sessionKey: string): void {
    const tmuxName = SESSION_PREFIX + sanitizeSessionName(sessionKey);
    killSession(tmuxName);
    const dir = outputDir(sessionKey);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }

  private _readResult(outPath: string, errPath: string): ClaudeResult {
    const stdout = existsSync(outPath) ? readFileSync(outPath, 'utf-8').trim() : '';
    const stderr = existsSync(errPath) ? readFileSync(errPath, 'utf-8').trim() : '';

    if (!stdout && stderr) {
      throw new Error(friendlyError(stderr));
    }
    if (!stdout) {
      throw new Error('Claude produced no output');
    }

    try {
      return parseClaudeJsonOutput(stdout);
    } catch {
      throw new Error(`Failed to parse claude output: ${stdout.slice(0, 200)}`);
    }
  }

  private _waitForResult(
    tmuxName: string,
    sessionKey: string,
    outPath: string,
    errPath: string,
    timeoutMs: number,
  ): Promise<ClaudeResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let healthCheckDone = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killSession(tmuxName);
        reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      // Health check: after 2 minutes, verify session is alive and output file exists
      const healthTimer = setTimeout(() => {
        if (settled) return;
        healthCheckDone = true;
        if (!sessionExists(tmuxName)) {
          // Session died early — check if it produced output
          tryResolve();
        }
      }, Math.min(HEALTH_CHECK_DELAY_MS, timeoutMs));

      // Watch the output directory for the file to appear/change
      let watcher: ReturnType<typeof watch> | undefined;
      try {
        const dir = outputDir(sessionKey);
        watcher = watch(dir, () => {
          if (!settled) tryResolve();
        });
      } catch {
        // watch may fail — fall through to polling
      }

      // Poll as fallback (fs.watch is not always reliable)
      const pollTimer = setInterval(() => {
        if (!settled) tryResolve();
      }, POLL_INTERVAL_MS);

      function tryResolve() {
        // tmux session still running → not done yet (unless health check says otherwise)
        if (sessionExists(tmuxName)) return;

        // Session has exited — read the result
        if (settled) return;
        settled = true;

        clearTimeout(timer);
        clearTimeout(healthTimer);
        clearInterval(pollTimer);
        if (watcher) watcher.close();

        try {
          const stdout = existsSync(outPath) ? readFileSync(outPath, 'utf-8').trim() : '';
          const stderr = existsSync(errPath) ? readFileSync(errPath, 'utf-8').trim() : '';

          if (!stdout && stderr) {
            reject(new Error(friendlyError(stderr)));
            return;
          }
          if (!stdout) {
            reject(new Error('Claude produced no output'));
            return;
          }

          const result = parseClaudeJsonOutput(stdout);
          resolve(result);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }
}

/** Escape a string for safe shell embedding in single quotes. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
