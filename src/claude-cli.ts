import { spawn } from 'node:child_process';

export interface ClaudeResult {
  text: string;
  sessionId: string;
  isError: boolean;
  sessionReset?: boolean;
}

export function parseClaudeJsonOutput(raw: string): ClaudeResult {
  const data = JSON.parse(raw);
  return {
    text: data.result ?? '',
    sessionId: data.session_id ?? '',
    isError: Boolean(data.is_error),
  };
}

export function buildClaudeArgs(
  baseArgs: string[],
  prompt: string,
  sessionId: string | undefined,
): string[] {
  const args = ['--print', ...baseArgs];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  args.push(prompt);
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

export function runClaude(
  cwd: string,
  baseArgs: string[],
  prompt: string,
  sessionId: string | undefined,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs(baseArgs, prompt, sessionId);
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
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
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}
