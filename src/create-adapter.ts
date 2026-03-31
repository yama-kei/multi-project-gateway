// src/create-adapter.ts
import type { ChannelAdapter } from './adapter.js';
import type { Router } from './router.js';
import type { SessionManager } from './session-manager.js';
import type { GatewayConfig } from './config.js';
import type { TurnCounter } from './turn-counter.js';
import { createDiscordBot } from './discord.js';

export interface AdapterDeps {
  token: string;
  router: Router;
  sessionManager: SessionManager;
  config: GatewayConfig;
  turnCounter?: TurnCounter;
  platform?: string;
}

export function createAdapter(deps: AdapterDeps): ChannelAdapter {
  const platform = deps.platform ?? process.env.CHAT_PLATFORM ?? 'discord';

  switch (platform) {
    case 'discord':
      return createDiscordBot(deps.token, deps.router, deps.sessionManager, deps.config, deps.turnCounter);
    default:
      throw new Error(`Unsupported CHAT_PLATFORM: ${platform}. Supported: discord`);
  }
}
