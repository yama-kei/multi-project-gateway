import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { GatewayConfig } from './config.js';

export function runHealthChecks(config: GatewayConfig): void {
  // 1. Check claude CLI is on PATH
  try {
    execFileSync('claude', ['--version'], { timeout: 5000, stdio: 'ignore' });
  } catch {
    console.error(
      'Health check failed:\n' +
      '  ✗ "claude" CLI not found on PATH. Install: https://docs.anthropic.com/en/docs/claude-code'
    );
    process.exit(1);
    return;
  }

  // 2. Check all project directories exist and are directories
  const missing: string[] = [];
  for (const [, project] of Object.entries(config.projects)) {
    try {
      if (!statSync(project.directory).isDirectory()) {
        missing.push(`  ✗ Project "${project.name}" path is not a directory: ${project.directory}`);
      }
    } catch {
      missing.push(`  ✗ Project "${project.name}" directory not found: ${project.directory}`);
    }
  }

  if (missing.length > 0) {
    console.error('Health check failed:\n' + missing.join('\n'));
    process.exit(1);
  }
}
