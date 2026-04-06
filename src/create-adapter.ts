// src/create-adapter.ts
import type { ChannelAdapter } from './adapter.js';
import type { Router } from './router.js';
import type { SessionManager } from './session-manager.js';
import type { GatewayConfig } from './config.js';
import type { TurnCounter } from './turn-counter.js';
import { createDiscordBot } from './discord.js';
import { createSlackBot } from './slack.js';

export interface AdapterDeps {
  token: string;
  router: Router;
  sessionManager: SessionManager;
  config: GatewayConfig;
  turnCounter?: TurnCounter;
  platform?: string;
  /** Slack App-Level Token for Socket Mode (xapp-...). Required when platform is 'slack'. */
  slackAppToken?: string;
}

export function createAdapter(deps: AdapterDeps): ChannelAdapter {
  const platform = deps.platform ?? process.env.CHAT_PLATFORM ?? 'discord';

  switch (platform) {
    case 'discord':
      return createDiscordBot(deps.token, deps.router, deps.sessionManager, deps.config, deps.turnCounter);
    case 'slack': {
      const appToken = deps.slackAppToken ?? process.env.SLACK_APP_TOKEN;
      if (!appToken) {
        throw new Error('SLACK_APP_TOKEN is required for Slack Socket Mode. Set it in the environment or pass slackAppToken.');
      }
      return createSlackBot(deps.token, appToken, deps.router, deps.sessionManager, deps.config, deps.turnCounter);
    }
    default:
      throw new Error(`Unsupported CHAT_PLATFORM: ${platform}. Supported: discord, slack`);
  }
}
