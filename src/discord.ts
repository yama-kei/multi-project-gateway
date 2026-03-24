import { Client, GatewayIntentBits, Events, ChannelType, type Message, type TextChannel, type ThreadChannel } from 'discord.js';
import type { Router } from './router.js';
import type { SessionManager } from './session-manager.js';
import { findChannelByName, type GatewayConfig } from './config.js';
import { parseDirective } from './directive-parser.js';
import type { AgentTracker } from './agent-tracker.js';
import type { ThreadLinkRegistry } from './thread-links.js';

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
  return findChannelByName(config, name);
}

function formatTimeSince(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export type BotMessageResult =
  | { action: 'ignore' }
  | { action: 'route-to-session' }
  | { action: 'cross-post'; targetChannelId: string; content: string; sourceChannelName: string }
  | { action: 'blocked'; reason: string };

export function handleBotMessage(ctx: {
  messageId: string;
  messageContent: string;
  isAgentMessage: boolean;
  isCrossPost: boolean;
  sourceChannelId: string;
  config: GatewayConfig;
}): BotMessageResult {
  if (ctx.isCrossPost) {
    return { action: 'route-to-session' };
  }

  if (!ctx.isAgentMessage) {
    return { action: 'ignore' };
  }

  const { directive } = parseDirective(ctx.messageContent);
  if (!directive) {
    return { action: 'ignore' };
  }

  // Resolve source channel persona
  const sourceProject = ctx.config.projects[ctx.sourceChannelId];
  if (!sourceProject?.persona) {
    return { action: 'blocked', reason: 'Source channel has no persona configured.' };
  }

  // Check canMessageChannels (strip # for comparison)
  const allowed = sourceProject.persona.canMessageChannels.map(c => c.replace(/^#/, '').toLowerCase());
  if (!allowed.includes(directive.targetChannel.toLowerCase())) {
    return { action: 'blocked', reason: `Posting to #${directive.targetChannel} is not allowed for this channel.` };
  }

  // Resolve target channel
  const target = findChannelByName(ctx.config, directive.targetChannel);
  if (!target) {
    return { action: 'blocked', reason: `Channel #${directive.targetChannel} not found in config.` };
  }

  return {
    action: 'cross-post',
    targetChannelId: target.channelId,
    content: directive.content,
    sourceChannelName: sourceProject.name,
  };
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

  if (cmd === '!restart') {
    const name = parts.slice(1).join(' ');
    if (!name) return 'Usage: `!restart <project name>`';
    const project = findProjectByName(config, name);
    if (!project) return `No project found matching "${name}".`;
    const restarted = sessionManager.restartSession(project.channelId);
    if (restarted) return `Session for **${project.name}** restarted — next message will start fresh context.`;
    return `**${project.name}** — no active session to restart.`;
  }

  if (cmd === '!help') {
    return [
      '**Gateway commands**',
      '`!sessions` — list all active sessions',
      '`!session` — show session for the current thread (or use `!session <name>`)',
      '`!restart <name>` — reset a session (fresh context, keeps worktree)',
      '`!kill <name>` — force-close a project session',
      '`!help` — show this message',
    ].join('\n');
  }

  return null;
}

export function createDiscordBot(
  router: Router,
  sessionManager: SessionManager,
  config: GatewayConfig,
  agentTracker?: AgentTracker,
  threadLinks?: ThreadLinkRegistry,
): DiscordBot {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) {
      if (!agentTracker || !threadLinks) return;

      const isCrossPost = agentTracker.isCrossPost(message.id);
      const isAgent = agentTracker.isAgentMessage(message.id);

      if (isCrossPost) {
        // Cross-posted directive content — route to session like a human message
        const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
        const resolved = router.resolve(message.channelId, parentId);
        if (!resolved) return;

        const typingInterval = setInterval(() => {
          if ('send' in message.channel) (message.channel as TextChannel | ThreadChannel).sendTyping().catch(() => {});
        }, 7_000);
        if ('send' in message.channel) (message.channel as TextChannel | ThreadChannel).sendTyping().catch(() => {});

        try {
          const result = await sessionManager.send(
            resolved.channelId,
            resolved.directory,
            message.content,
            resolved.isThread ? { worktree: true } : undefined,
          );

          const chunks = chunkMessage(result.text, 2000);
          for (const chunk of chunks) {
            const sent = await (message.channel as TextChannel | ThreadChannel).send(chunk);
            agentTracker.track(sent.id);
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await (message.channel as TextChannel | ThreadChannel).send(
            `**Error** (${resolved.name}): ${errorMsg.slice(0, 1800)}`,
          );
        } finally {
          clearInterval(typingInterval);
        }
        return;
      }

      if (isAgent) {
        const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
        const resolved = router.resolve(message.channelId, parentId);
        if (!resolved) return;

        const botResult = handleBotMessage({
          messageId: message.id,
          messageContent: message.content,
          isAgentMessage: true,
          isCrossPost: false,
          sourceChannelId: resolved.channelId,
          config,
        });

        if (botResult.action === 'cross-post') {
          const maxTurns = config.defaults.maxTurnsPerLink;
          const sourceThread = message.channelId;

          let existingLink = threadLinks.getLinkedThread(sourceThread);
          let targetThread: ThreadChannel;

          if (existingLink) {
            const linkedThreadId = existingLink.sourceThread === sourceThread
              ? existingLink.targetThread
              : existingLink.sourceThread;

            if (threadLinks.isOverLimit(sourceThread, linkedThreadId, maxTurns)) {
              await (message.channel as TextChannel | ThreadChannel).send(
                `⚠️ Loop limit reached (${maxTurns} turns) — a human message in either thread will reset.`,
              );
              return;
            }

            try {
              const channel = await message.client.channels.fetch(linkedThreadId);
              if (channel && 'send' in channel) {
                targetThread = channel as ThreadChannel;
              } else {
                return;
              }
            } catch {
              return;
            }
          } else {
            try {
              const targetChannel = await message.client.channels.fetch(botResult.targetChannelId);
              if (!targetChannel || !('threads' in targetChannel)) return;
              const threadName = `From #${botResult.sourceChannelName}: ${botResult.content.slice(0, 80)}`;
              targetThread = await (targetChannel as TextChannel).threads.create({
                name: threadName,
                autoArchiveDuration: 1440,
              });
              threadLinks.link(sourceThread, targetThread.id, botResult.sourceChannelName);
            } catch {
              return;
            }
          }

          threadLinks.recordTurn(sourceThread, targetThread.id);

          const attributedMessage = `**From #${botResult.sourceChannelName}:**\n${botResult.content}`;
          const sent = await targetThread.send(attributedMessage);
          agentTracker.trackCrossPost(sent.id);
        } else if (botResult.action === 'blocked') {
          await (message.channel as TextChannel | ThreadChannel).send(`⚠️ ${botResult.reason}`);
        }
        return;
      }

      // Neither agent nor cross-post — gateway status message, ignore
      return;
    }

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

    // Reset loop counter if human message is in a linked thread
    if (threadLinks && message.channel.isThread()) {
      const link = threadLinks.getLinkedThread(message.channelId);
      if (link) {
        threadLinks.resetPair(link.sourceThread, link.targetThread);
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
          autoArchiveDuration: 1440,
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
      } else if (result.sessionChanged) {
        await replyChannel.send('⚠️ Claude started a new session — previous conversation context may be lost.');
      }

      const chunks = chunkMessage(result.text, 2000);
      for (const chunk of chunks) {
        const sent = await replyChannel.send(chunk);
        if (agentTracker) agentTracker.track(sent.id);
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
