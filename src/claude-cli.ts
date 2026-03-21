import { spawn } from 'node:child_process';

export interface ClaudeResult {
  text: string;
  sessionId: string;
  isError: boolean;
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
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
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
