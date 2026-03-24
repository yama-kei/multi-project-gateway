import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createRouter } from './router.js';
import { createSessionManager } from './session-manager.js';
import { createFileSessionStore } from './session-store.js';
import { createDiscordBot } from './discord.js';
import { runInit } from './init.js';
import { runHealthChecks } from './health.js';
import { reconcileWorktrees } from './worktree.js';
import {
  resolveEnvPath,
  resolveConfigPath,
  resolveSessionsPath,
  resolveMpgHome,
  resolveProfileDir,
  parseFlags,
} from './resolve-home.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'start';
const flags = parseFlags(args.slice(1));

async function main() {
  switch (command) {
    case 'start':
      return start();
    case 'init':
      if (flags.migrate) {
        return migrate();
      }
      return runInit(flags.profileFlag);
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
  --profile <name>  Use a named profile (default: "default")
  --config <path>   Use a specific config.json path
  --migrate         Copy CWD config files into ~/.mpg/profiles/default/
  -v, --version     Show version
  -h, --help        Show this message

Environment:
  MPG_HOME          Override config home (default: ~/.mpg)
`.trim());
}

function version() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  console.log(`mpg v${pkg.version}`);
}

function start() {
  // Load .env using resolution order
  const envPath = resolveEnvPath();
  if (envPath) {
    loadEnv({ path: envPath });
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('DISCORD_BOT_TOKEN is not set. Run `mpg init` or set it in .env');
    process.exit(1);
  }

  const configPath = resolveConfigPath({
    configFlag: flags.configFlag,
    profileFlag: flags.profileFlag,
  });
  if (!configPath || !existsSync(configPath)) {
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

  console.log(`Loaded ${projectCount} project(s) from ${configPath}`);

  const router = createRouter(config);
  const sessionsPath = resolveSessionsPath(configPath);
  const sessionStore = createFileSessionStore(sessionsPath);
  const sessionManager = createSessionManager(config.defaults, sessionStore);

  // Reconcile orphaned worktrees from crashed sessions
  const persistedSessions = sessionStore.load();
  const knownKeysByProject = new Map<string, Set<string>>();
  for (const [key, entry] of persistedSessions) {
    if (entry.projectDir) {
      let keys = knownKeysByProject.get(entry.projectDir);
      if (!keys) {
        keys = new Set();
        knownKeysByProject.set(entry.projectDir, keys);
      }
      keys.add(key);
    }
  }
  for (const [projectDir, keys] of knownKeysByProject) {
    reconcileWorktrees(projectDir, keys);
  }

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
  const configPath = resolveConfigPath({
    configFlag: flags.configFlag,
    profileFlag: flags.profileFlag,
  });

  const sessionsPath = configPath
    ? resolveSessionsPath(configPath)
    : resolve(process.cwd(), '.sessions.json');

  if (!existsSync(sessionsPath)) {
    console.log('No sessions file found. Is the gateway running?');
    return;
  }

  let projectNames: Record<string, string> = {};
  if (configPath && existsSync(configPath)) {
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

function migrate() {
  const mpgHome = resolveMpgHome();
  const profileDir = resolveProfileDir('default');

  const cwdEnv = resolve(process.cwd(), '.env');
  const cwdConfig = resolve(process.cwd(), 'config.json');
  const cwdSessions = resolve(process.cwd(), '.sessions.json');

  const copied: string[] = [];

  // Create directories
  mkdirSync(profileDir, { recursive: true });

  // Copy .env to MPG_HOME root
  if (existsSync(cwdEnv)) {
    const dest = resolve(mpgHome, '.env');
    copyFileSync(cwdEnv, dest);
    copied.push(`  ${cwdEnv} → ${dest}`);
  }

  // Copy config.json to profile dir
  if (existsSync(cwdConfig)) {
    const dest = resolve(profileDir, 'config.json');
    copyFileSync(cwdConfig, dest);
    copied.push(`  ${cwdConfig} → ${dest}`);
  }

  // Copy sessions.json to profile dir
  if (existsSync(cwdSessions)) {
    const dest = resolve(profileDir, 'sessions.json');
    copyFileSync(cwdSessions, dest);
    copied.push(`  ${cwdSessions} → ${dest}`);
  }

  if (copied.length === 0) {
    console.log('No config files found in current directory. Nothing to migrate.');
    return;
  }

  console.log(`Migrated files to ${mpgHome}:\n`);
  for (const line of copied) {
    console.log(line);
  }
  console.log(`\nProfile directory: ${profileDir}`);
  console.log('You can now run `mpg start` from any directory.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
