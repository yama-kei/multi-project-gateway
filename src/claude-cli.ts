import { spawn } from 'node:child_process';

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  model?: string;
}

export interface ClaudeResult {
  text: string;
  sessionId: string;
  isError: boolean;
  sessionReset?: boolean;
  sessionChanged?: boolean;
  usage?: ClaudeUsage;
}

export function parseClaudeJsonOutput(raw: string): ClaudeResult {
  const data = JSON.parse(raw);
  let usage: ClaudeUsage | undefined;
  if (data.total_cost_usd != null || data.usage) {
    const model = data.model
      ?? (data.modelUsage ? Object.keys(data.modelUsage)[0] : undefined);
    usage = {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
      total_cost_usd: data.total_cost_usd ?? 0,
      duration_ms: data.duration_ms ?? 0,
      duration_api_ms: data.duration_api_ms ?? 0,
      num_turns: data.num_turns ?? 0,
      model,
    };
  }
  return {
    text: data.result ?? '',
    sessionId: data.session_id ?? '',
    isError: Boolean(data.is_error),
    usage,
  };
}

export interface ToolRestrictions {
  allowedTools?: string[];
  disallowedTools?: string[];
}

/**
 * Build --allowed-tools / --disallowed-tools CLI args from config.
 * Per-project overrides take precedence over gateway defaults.
 * If both allowed and disallowed are set, allowed takes precedence
 * (disallowed is ignored) — config validation already warns about this.
 * Skips tool flags if baseArgs already contain them (manual claudeArgs override).
 */
export function buildToolArgs(
  defaults: ToolRestrictions,
  projectOverrides?: ToolRestrictions,
  existingArgs?: string[],
): string[] {
  // If the user already manually set tool flags in claudeArgs, don't conflict
  if (existingArgs?.includes('--allowed-tools') || existingArgs?.includes('--disallowed-tools')) {
    return [];
  }

  // Per-project overrides take precedence over gateway defaults
  const allowed = projectOverrides?.allowedTools ?? defaults.allowedTools;
  const disallowed = projectOverrides?.disallowedTools ?? defaults.disallowedTools;

  const args: string[] = [];

  if (allowed && allowed.length > 0) {
    args.push('--allowed-tools', ...allowed);
  } else if (disallowed && disallowed.length > 0) {
    args.push('--disallowed-tools', ...disallowed);
  }

  return args;
}

export function buildClaudeArgs(
  baseArgs: string[],
  prompt: string,
  sessionId: string | undefined,
  systemPrompt?: string,
): string[] {
  // Prompt MUST come before variadic flags like --allowed-tools which consume
  // all subsequent positional args. Place it right after --print.
  const args = ['--print', prompt, ...baseArgs];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }
  return args;
}

export function friendlyError(stderr: string): string {
  const combined = stderr.toLowerCase();
  if (combined.includes('rate limit') || combined.includes('rate_limit_error')) {
    return 'Claude usage limit reached — please wait a few minutes and try again.';
  }
  if (combined.includes('overloaded') || combined.includes('overloaded_error')) {
    return 'Claude API is temporarily overloaded — please try again shortly.';
  }
  if (combined.includes('invalid api key') || combined.includes('authentication_error') || combined.includes('authentication failed')) {
    return 'Claude authentication failed — check your API key or CLI login.';
  }
  if (combined.includes('no messages returned')) {
    return 'Claude returned an empty response — try sending your message again.';
  }
  return `Claude error: ${stderr.slice(0, 500)}`;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

export function runClaude(
  cwd: string,
  baseArgs: string[],
  prompt: string,
  sessionId: string | undefined,
  systemPrompt?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs(baseArgs, prompt, sessionId, systemPrompt);
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s`));
      }
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(friendlyError(stderr)));
        return;
      }
      try {
        const result = parseClaudeJsonOutput(stdout.trim());
        resolve(result);
      } catch (err) {
        reject(new Error(`Failed to parse claude output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);

      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}
