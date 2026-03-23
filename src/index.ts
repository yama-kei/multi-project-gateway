import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createRouter } from './router.js';
import { createSessionManager } from './session-manager.js';
import { createFileSessionStore } from './session-store.js';
import { createDiscordBot } from './discord.js';

loadEnv();

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('DISCORD_BOT_TOKEN environment variable is required');
  process.exit(1);
}

const configPath = resolve(process.cwd(), 'config.json');
const rawConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
const config = loadConfig(rawConfig);

const projectCount = Object.keys(config.projects).length;
if (projectCount === 0) {
  console.error('No projects configured in config.json');
  process.exit(1);
}
console.log(`Loaded ${projectCount} project(s) from config`);

const router = createRouter(config);
const sessionStore = createFileSessionStore(resolve(process.cwd(), '.sessions.json'));
const sessionManager = createSessionManager(config.defaults, sessionStore);
const bot = createDiscordBot(router, sessionManager);

// Graceful shutdown
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
