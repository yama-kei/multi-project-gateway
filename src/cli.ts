import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createRouter } from './router.js';
import { createSessionManager } from './session-manager.js';
import { createFileSessionStore } from './session-store.js';
import { createDiscordBot } from './discord.js';
import { runInit } from './init.js';
import { runHealthChecks } from './health.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'start';

async function main() {
  switch (command) {
    case 'start':
      return start();
    case 'init':
      return runInit();
    case 'status':
      return status();
    case 'help':
    case '--help':
    case '-h':
      return help();
    case '--version':
    case '-v':
      return version();
    default:
      console.error(`Unknown command: ${command}`);
      help();
      process.exit(1);
  }
}

function help() {
  console.log(`
mpg — multi-project gateway for Claude Code

Usage: mpg <command>

Commands:
  start     Start the gateway (default)
  init      Interactive setup wizard
  status    Show session status
  help      Show this message

Options:
  -v, --version  Show version
  -h, --help     Show this message
`.trim());
}

function version() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  console.log(`mpg v${pkg.version}`);
}

function start() {
  const configDir = process.cwd();
  const envPath = resolve(configDir, '.env');
  if (existsSync(envPath)) {
    loadEnv({ path: envPath });
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('DISCORD_BOT_TOKEN is not set. Run `mpg init` or set it in .env');
    process.exit(1);
  }

  const configPath = resolve(configDir, 'config.json');
  if (!existsSync(configPath)) {
    console.error('config.json not found. Run `mpg init` to create one.');
    process.exit(1);
  }

  const rawConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  const config = loadConfig(rawConfig);

  const projectCount = Object.keys(config.projects).length;
  if (projectCount === 0) {
    console.error('No projects configured in config.json');
    process.exit(1);
  }

  runHealthChecks(config);

  console.log(`Loaded ${projectCount} project(s) from config`);

  const router = createRouter(config);
  const sessionStore = createFileSessionStore(resolve(configDir, '.sessions.json'));
  const sessionManager = createSessionManager(config.defaults, sessionStore);
  const bot = createDiscordBot(router, sessionManager, config);

  function shutdown() {
    console.log('Shutting down...');
    sessionManager.shutdown();
    bot.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  bot.start(token).catch((err) => {
    console.error('Failed to start bot:', err);
    process.exit(1);
  });
}

function status() {
  const configDir = process.cwd();
  const sessionsPath = resolve(configDir, '.sessions.json');

  if (!existsSync(sessionsPath)) {
    console.log('No sessions file found. Is the gateway running?');
    return;
  }

  const configPath = resolve(configDir, 'config.json');
  let projectNames: Record<string, string> = {};
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      const config = loadConfig(raw);
      for (const [channelId, project] of Object.entries(config.projects)) {
        projectNames[channelId] = project.name;
      }
    } catch {
      // ignore config errors for status
    }
  }

  const sessions = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as Array<{
    sessionId: string;
    projectKey: string;
    cwd: string;
    lastActivity: number;
  }>;

  if (sessions.length === 0) {
    console.log('No active sessions.');
    return;
  }

  console.log(`Sessions (${sessions.length}):\n`);
  for (const s of sessions) {
    const name = projectNames[s.projectKey] ?? s.projectKey;
    const ago = Math.floor((Date.now() - s.lastActivity) / 60000);
    console.log(`  ${name}`);
    console.log(`    Session: ${s.sessionId}`);
    console.log(`    Dir:     ${s.cwd}`);
    console.log(`    Idle:    ${ago}m`);
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
