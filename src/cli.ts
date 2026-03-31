import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createRouter } from './router.js';
import { createSessionManager } from './session-manager.js';
import { createFileSessionStore } from './session-store.js';
import { ClaudeCliRuntime } from './runtimes/claude-cli-runtime.js';
import { TmuxRuntime } from './runtimes/tmux-runtime.js';
import type { AgentRuntime } from './agent-runtime.js';
import { listSessions, killSession } from './tmux.js';
import { createDiscordBot } from './discord.js';
import { createPulseEmitter } from './pulse-events.js';
import { createActivityEngine } from './activity-engine.js';
import { createDashboardServer, type DashboardServer } from './dashboard-server.js';
import { createTurnCounter } from './turn-counter.js';
import { runInit } from './init.js';
import { runHealthChecks } from './health.js';
import { reconcileWorktrees } from './worktree.js';
import { checkPidFile, writePid, removePid } from './pid.js';
import { createFileWriter } from './file-logger.js';
import { daemonInstall, daemonUninstall, daemonStatus, daemonLogs } from './daemon.js';
import {
  resolveEnvPath,
  resolveConfigPath,
  resolveSessionsPath,
  resolveMpgHome,
  resolveProfileDir,
  resolvePidPath,
  resolveLogPath,
  parseFlags,
} from './resolve-home.js';
import { createLogger, parseLogEntry, filterLogEntries, type LogLevel, isValidLogLevel } from './logger.js';

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
    case 'stop':
      return stop();
    case 'daemon':
      return daemon();
    case 'logs':
      return logs();
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
  start                Start the gateway (default)
  stop                 Stop a running gateway instance
  init                 Interactive setup wizard
  status               Show session status
  logs                 Filter structured log output (reads stdin)
  daemon install       Install systemd user service
  daemon uninstall     Remove systemd user service
  daemon status        Show systemd service status
  daemon logs          Show service logs (journalctl)
  help                 Show this message

Options:
  --profile <name>   Use a named profile (default: "default")
  --config <path>    Use a specific config.json path
  --migrate          Copy CWD config files into ~/.mpg/profiles/default/
  --project <name>   (logs) Filter by project name
  --level <level>    (logs) Filter by minimum log level (debug|info|warn|error)
  --follow, -f       (daemon logs) Follow log output
  -v, --version      Show version
  -h, --help         Show this message

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

  // Check for existing instance
  const pidPath = resolvePidPath(flags.profileFlag);
  const pidCheck = checkPidFile(pidPath);
  if (pidCheck.status === 'running') {
    console.error(`MPG is already running (PID ${pidCheck.pid}). Use \`mpg stop\` first.`);
    process.exit(1);
  }
  writePid(pidPath);

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

  const logPath = resolveLogPath(flags.profileFlag);
  const fileWriter = createFileWriter(logPath);
  const log = createLogger(config.defaults.logLevel, (line: string) => {
    fileWriter(line);
    process.stderr.write(line + '\n');
  });

  const projectCount = Object.keys(config.projects).length;
  if (projectCount === 0) {
    console.error('No projects configured in config.json');
    process.exit(1);
  }

  runHealthChecks(config);

  log.info(`Loaded ${projectCount} project(s) from ${configPath}`);

  const router = createRouter(config);
  const sessionsPath = resolveSessionsPath(configPath);
  const sessionStore = createFileSessionStore(sessionsPath);
  const pulseEmitter = createPulseEmitter();
  let runtime: AgentRuntime;
  if (config.defaults.persistence === 'tmux') {
    runtime = new TmuxRuntime();
    log.info('Using tmux-based persistent runtime');
  } else {
    runtime = new ClaudeCliRuntime();

    // Sweep stale tmux sessions from a previous tmux-mode run
    try {
      const stale = listSessions('mpg-');
      for (const name of stale) {
        killSession(name);
      }
      if (stale.length > 0) {
        log.info(`Cleaned up ${stale.length} stale tmux session(s)`);
      }
    } catch {
      // tmux not installed — nothing to sweep
    }
  }
  const sessionManager = createSessionManager(config.defaults, runtime, sessionStore, pulseEmitter);

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

  const turnCounter = createTurnCounter();
  const bot = createDiscordBot(router, sessionManager, config, turnCounter);

  let dashboardServer: DashboardServer | undefined;

  function shutdown() {
    log.info('Shutting down...');
    removePid(pidPath);
    if (dashboardServer) {
      dashboardServer.close().catch(() => {});
    }
    sessionManager.shutdown();
    bot.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  bot.start(token)
    .then(async () => {
      if (config.defaults.httpPort !== false) {
        try {
          const activityEngine = createActivityEngine();
          dashboardServer = await createDashboardServer(config.defaults.httpPort, sessionManager, bot, config, { activityEngine });
        } catch (err) {
          log.warn(`Dashboard server failed to start on port ${config.defaults.httpPort}: ${err}`);
        }
      }

      // Recover orphaned tmux sessions after Discord is connected
      sessionManager.recoverOrphanedSessions({
        onStart(projectKey) {
          bot.notifyRecoveryStart(projectKey);
        },
        onResult(projectKey, result) {
          bot.deliverOrphanResult(projectKey, result).catch((err) => {
            log.error(`Failed to deliver orphan result for ${projectKey}: ${err}`);
          });
        },
      }).catch((err) => {
        log.error(`Orphan session recovery failed: ${err}`);
      });
    })
    .catch((err) => {
      log.error(`Failed to start bot: ${err}`);
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

function stop() {
  const pidPath = resolvePidPath(flags.profileFlag);
  const check = checkPidFile(pidPath);

  if (check.status === 'none') {
    console.log('No running MPG instance found.');
    return;
  }

  if (check.status === 'stale') {
    console.log(`Removed stale PID file (process ${check.pid} was not running).`);
    return;
  }

  const { pid } = check;
  console.log(`Sending SIGTERM to MPG (PID ${pid})...`);

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`Failed to send signal: ${err}`);
    process.exit(1);
  }

  // Wait up to 10 seconds for graceful shutdown
  const deadline = Date.now() + 10_000;
  const poll = setInterval(() => {
    try {
      process.kill(pid, 0);
      // Still running
      if (Date.now() > deadline) {
        clearInterval(poll);
        console.log('Graceful shutdown timed out. Sending SIGKILL...');
        try {
          process.kill(pid, 'SIGKILL');
        } catch { /* ignore */ }
        removePid(pidPath);
        console.log('Killed.');
        process.exit(0);
      }
    } catch {
      // Process is gone
      clearInterval(poll);
      removePid(pidPath);
      console.log('Stopped.');
      process.exit(0);
    }
  }, 200);
}

function daemon() {
  const subcommand = args[1];
  const daemonFlags = parseFlags(args.slice(2));
  const profile = daemonFlags.profileFlag ?? flags.profileFlag;

  switch (subcommand) {
    case 'install':
      return daemonInstall(profile);
    case 'uninstall':
      return daemonUninstall(profile);
    case 'status':
      return daemonStatus(profile);
    case 'logs':
      return daemonLogs(profile, daemonFlags.follow);
    default:
      console.error(`Unknown daemon subcommand: ${subcommand}`);
      console.error('Usage: mpg daemon <install|uninstall|status|logs>');
      process.exit(1);
  }
}

function logs() {
  const levelFlag = flags.level;
  const projectFlag = flags.project;

  if (levelFlag && !isValidLogLevel(levelFlag)) {
    console.error(`Invalid log level: ${levelFlag}. Must be one of: debug, info, warn, error`);
    process.exit(1);
  }

  const minLevel = levelFlag as LogLevel | undefined;

  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseLogEntry(line);
      if (!entry) {
        // Pass through non-JSON lines as-is
        process.stdout.write(line + '\n');
        continue;
      }
      const [filtered] = filterLogEntries([entry], { project: projectFlag, level: minLevel });
      if (filtered) {
        const ts = entry.timestamp.replace('T', ' ').replace('Z', '');
        const proj = entry.project ? ` [${entry.project}]` : '';
        const sess = entry.session ? ` (${entry.session.slice(0, 8)})` : '';
        process.stdout.write(`${ts} ${entry.level.toUpperCase().padEnd(5)}${proj}${sess} ${entry.message}\n`);
      }
    }
  });

  process.stdin.on('end', () => {
    if (buffer.trim()) {
      const entry = parseLogEntry(buffer);
      if (!entry) {
        process.stdout.write(buffer + '\n');
      } else {
        const [filtered] = filterLogEntries([entry], { project: projectFlag, level: minLevel });
        if (filtered) {
          const ts = entry.timestamp.replace('T', ' ').replace('Z', '');
          const proj = entry.project ? ` [${entry.project}]` : '';
          const sess = entry.session ? ` (${entry.session.slice(0, 8)})` : '';
          process.stdout.write(`${ts} ${entry.level.toUpperCase().padEnd(5)}${proj}${sess} ${entry.message}\n`);
        }
      }
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
