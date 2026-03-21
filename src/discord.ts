import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import type { Router } from './router.js';
import type { SessionManager } from './session-manager.js';

export function chunkMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

export interface DiscordBot {
  start(token: string): Promise<void>;
  stop(): void;
}

export function createDiscordBot(router: Router, sessionManager: SessionManager): DiscordBot {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    if (!('send' in message.channel)) return;

    const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
    const resolved = router.resolve(message.channelId, parentId);
    if (!resolved) return;

    try {
      await message.react('👀');
    } catch {
      // Reaction may fail if permissions are missing — non-critical
    }

    try {
      const result = await sessionManager.send(
        resolved.channelId,
        resolved.directory,
        message.content,
      );

      const chunks = chunkMessage(result.text, 2000);
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await message.channel.send(
        `**Error** (${resolved.name}): ${errorMsg.slice(0, 1800)}`,
      );
    }
  });

  return {
    async start(token: string) {
      await client.login(token);
      console.log(`Gateway connected as ${client.user?.tag}`);
    },
    stop() {
      client.destroy();
    },
  };
}
