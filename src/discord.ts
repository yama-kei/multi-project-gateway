import { Client, GatewayIntentBits, Events, ChannelType, type Message, type TextChannel, type ThreadChannel } from 'discord.js';
import type { Router } from './router.js';
import type { SessionManager } from './session-manager.js';
import type { GatewayConfig } from './config.js';

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

function resolveProjectName(config: GatewayConfig, channelId: string): string {
  return config.projects[channelId]?.name ?? channelId;
}

function findProjectByName(config: GatewayConfig, name: string): { channelId: string; name: string } | null {
  const lower = name.toLowerCase();
  for (const [channelId, project] of Object.entries(config.projects)) {
    if (project.name.toLowerCase() === lower) {
      return { channelId, name: project.name };
    }
  }
  return null;
}

function formatTimeSince(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export function handleCommand(
  command: string,
  config: GatewayConfig,
  sessionManager: SessionManager,
  context?: { channelId: string; projectName: string; isThread: boolean },
): string | null {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '!sessions') {
    const allSessions = sessionManager.listSessions();
    if (allSessions.length === 0) {
      return 'No active sessions.';
    }
    const lines = allSessions.map((s) => {
      const name = resolveProjectName(config, s.projectKey);
      const idle = formatTimeSince(s.lastActivity);
      const queue = s.queueLength > 0 ? ` | queue: ${s.queueLength}` : '';
      const sid = s.sessionId ? ` | \`${s.sessionId.slice(0, 8)}…\`` : '';
      return `- **${name}** — last active ${idle}${queue}${sid}`;
    });
    return `**Active sessions (${allSessions.length})**\n${lines.join('\n')}`;
  }

  if (cmd === '!session') {
    const name = parts.slice(1).join(' ');

    // No arguments: show session for the current thread (or project channel)
    if (!name && context) {
      const info = sessionManager.getSession(context.channelId);
      if (!info) return `**${context.projectName}** — no active session in this ${context.isThread ? 'thread' : 'channel'}.`;
      const idle = formatTimeSince(info.lastActivity);
      const sid = info.sessionId || 'none';
      return [
        `**${context.projectName}**${context.isThread ? ' (thread)' : ''}`,
        `Session ID: \`${sid}\``,
        `Last active: ${idle}`,
        `Queue depth: ${info.queueLength}`,
      ].join('\n');
    }

    if (!name) return 'Usage: `!session <project name>` or run `!session` in a thread';
    const project = findProjectByName(config, name);
    if (!project) return `No project found matching "${name}".`;
    const info = sessionManager.getSession(project.channelId);
    if (!info) return `**${project.name}** — no active session.`;
    const idle = formatTimeSince(info.lastActivity);
    const sid = info.sessionId || 'none';
    return [
      `**${project.name}**`,
      `Session ID: \`${sid}\``,
      `Last active: ${idle}`,
      `Queue depth: ${info.queueLength}`,
    ].join('\n');
  }

  if (cmd === '!kill') {
    const name = parts.slice(1).join(' ');
    if (!name) return 'Usage: `!kill <project name>`';
    const project = findProjectByName(config, name);
    if (!project) return `No project found matching "${name}".`;
    const cleared = sessionManager.clearSession(project.channelId);
    if (cleared) return `Session for **${project.name}** cleared.`;
    return `**${project.name}** — no active session to clear.`;
  }

  if (cmd === '!help') {
    return [
      '**Gateway commands**',
      '`!sessions` — list all active sessions',
      '`!session` — show session for the current thread (or use `!session <name>`)',
      '`!kill <name>` — force-close a project session',
      '`!help` — show this message',
    ].join('\n');
  }

  return null;
}

export function createDiscordBot(router: Router, sessionManager: SessionManager, config: GatewayConfig): DiscordBot {
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

    // Handle gateway commands from any mapped channel
    if (message.content.startsWith('!')) {
      const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
      const resolved = router.resolve(message.channelId, parentId);
      if (resolved) {
        const response = handleCommand(message.content, config, sessionManager, {
          channelId: resolved.channelId,
          projectName: resolved.name,
          isThread: resolved.isThread,
        });
        if (response) {
          await message.channel.send(response);
          return;
        }
      }
    }

    const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
    const resolved = router.resolve(message.channelId, parentId);
    if (!resolved) return;

    try {
      await message.react('👀');
    } catch {
      // Reaction may fail if permissions are missing — non-critical
    }

    // If the message is in a main channel, create a thread for the response.
    // If already in a thread, reply there directly.
    let replyChannel: TextChannel | ThreadChannel;
    if (message.channel.isThread()) {
      replyChannel = message.channel;
    } else {
      try {
        replyChannel = await message.startThread({
          name: message.content.slice(0, 100) || 'Claude response',
          autoArchiveDuration: 60,
        });
      } catch {
        // Thread creation may fail (permissions, channel type) — fall back to channel
        replyChannel = message.channel as TextChannel;
      }
    }

    // Show typing indicator while Claude is processing
    const typingInterval = setInterval(() => {
      replyChannel.sendTyping().catch(() => {});
    }, 7_000);
    replyChannel.sendTyping().catch(() => {});

    try {
      const result = await sessionManager.send(
        resolved.channelId,
        resolved.directory,
        message.content,
        resolved.isThread ? { worktree: true } : undefined,
      );

      if (result.sessionReset) {
        await replyChannel.send('⚠️ Previous session expired — starting fresh.');
      }

      const chunks = chunkMessage(result.text, 2000);
      for (const chunk of chunks) {
        await replyChannel.send(chunk);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await replyChannel.send(
        `**Error** (${resolved.name}): ${errorMsg.slice(0, 1800)}`,
      );
    } finally {
      clearInterval(typingInterval);
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
