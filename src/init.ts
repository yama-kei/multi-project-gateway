import { createInterface } from 'node:readline';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

function createPrompt(): (question: string) => Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return (question: string) =>
    new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

export async function runInit() {
  const ask = createPrompt();
  const configDir = process.cwd();

  console.log('\nmpg init — set up multi-project gateway\n');

  // Check for claude CLI
  try {
    execSync('claude --version', { stdio: 'pipe' });
    console.log('Claude CLI found.');
  } catch {
    console.warn('Warning: `claude` not found on PATH. Make sure it is installed before starting the gateway.');
  }

  // Discord bot token
  let token = process.env.DISCORD_BOT_TOKEN ?? '';
  const inputToken = await ask(`Discord bot token${token ? ' (press Enter to keep existing)' : ''}: `);
  if (inputToken) token = inputToken;
  if (!token) {
    console.error('A Discord bot token is required. Create one at https://discord.com/developers/applications');
    process.exit(1);
  }

  // Write .env
  const envPath = resolve(configDir, '.env');
  writeFileSync(envPath, `DISCORD_BOT_TOKEN=${token}\n`);
  console.log(`Wrote ${envPath}`);

  // Collect projects
  interface ProjectEntry {
    name: string;
    directory: string;
    channelId: string;
  }

  const projects: ProjectEntry[] = [];

  // Load existing config if present
  const configPath = resolve(configDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(
        (await import('node:fs')).readFileSync(configPath, 'utf-8'),
      );
      if (existing.projects) {
        for (const [channelId, project] of Object.entries(existing.projects)) {
          const p = project as { name?: string; directory: string };
          projects.push({ name: p.name ?? channelId, directory: p.directory, channelId });
        }
        if (projects.length > 0) {
          console.log(`\nExisting projects (${projects.length}):`);
          for (const p of projects) {
            console.log(`  ${p.name} → ${p.directory} (${p.channelId})`);
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  console.log('\nAdd projects (empty name to finish):\n');

  while (true) {
    const name = await ask('Project name: ');
    if (!name) break;

    const directory = await ask('Project directory (absolute path): ');
    if (!directory) {
      console.log('Directory is required, skipping.');
      continue;
    }
    if (!existsSync(directory)) {
      console.warn(`Warning: ${directory} does not exist.`);
    }

    const channelId = await ask('Discord channel ID: ');
    if (!channelId) {
      console.log('Channel ID is required, skipping.');
      continue;
    }

    projects.push({ name, directory, channelId });
    console.log(`Added ${name}\n`);
  }

  if (projects.length === 0) {
    console.log('No projects configured. You can edit config.json later.');
  }

  // Build config
  const config = {
    defaults: {
      idleTimeoutMinutes: 1440,
      maxConcurrentSessions: 4,
      claudeArgs: ['--permission-mode', 'acceptEdits', '--output-format', 'json'],
    },
    projects: Object.fromEntries(
      projects.map((p) => [p.channelId, { name: p.name, directory: p.directory }]),
    ),
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote ${configPath}`);

  console.log('\nSetup complete! Run `mpg start` to launch the gateway.');
}
