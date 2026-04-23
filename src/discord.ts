import { Client, GatewayIntentBits, Events, Status, type Message, type TextChannel, type ThreadChannel } from 'discord.js';
import type { Router } from './router.js';
import type { SessionManager } from './session-manager.js';
import { type GatewayConfig, resolveAgentTimeout } from './config.js';
import { buildToolArgs } from './claude-cli.js';
import { parseAgentMention, parseAgentCommand, extractAskTarget, parseHandoffCommand, parseAllHandoffs, parseThreadName, stripThreadName } from './agent-dispatch.js';
import { sendAgentMessage, buildHandoffEmbed, buildFanOutEmbed } from './embed-format.js';
import type { TurnCounter } from './turn-counter.js';
import type { ChannelAdapter } from './adapter.js';
import { hasAllowedRole } from './role-check.js';
import { createRateLimiter } from './rate-limiter.js';
import { downloadAttachments, buildAttachmentPrompt, type AttachmentConfig, DEFAULT_ATTACHMENT_CONFIG } from './attachments.js';
import type { AgentConfig } from './config.js';
import { resolveLifeContextRun as resolveLifeContextRunImpl, type GetLifeContextRunArgs } from './life-context-spawn.js';
// Ayumi life-context module — optional, gracefully absent
let getAgentContext: (agentName: string) => Promise<string | null> = async () => null;
let getLifeContextRunArgs: GetLifeContextRunArgs = () => null;
try {
  const ayumi = await import('./ayumi/index.js');
  getAgentContext = ayumi.getAgentContext;
  getLifeContextRunArgs = ayumi.getLifeContextRunArgs;
} catch {
  // Ayumi module not available — no life context injection
}

function resolveLifeContextRun(
  agentName: string | undefined,
  defaultCwd: string,
  defaultExtraArgs: string[],
): { cwd: string; extraArgs: string[] | undefined } {
  return resolveLifeContextRunImpl(getLifeContextRunArgs, agentName, defaultCwd, defaultExtraArgs);
}

// Ayumi curator commands — optional, gracefully absent
let handleCuratorCommand: ((text: string) => Promise<string | null>) | null = null;
try {
  const curatorModule = await import('./ayumi/curator-commands.js');
  handleCuratorCommand = curatorModule.handleCuratorCommand;
} catch {
  // Ayumi module not available — curator commands disabled
}

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

export interface DiscordBot extends ChannelAdapter {
  /** Return the guild ID of the connected server, or null if not yet available. */
  getGuildId(): string | null;
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

  if (cmd === '!restart') {
    const name = parts.slice(1).join(' ');
    if (!name) return 'Usage: `!restart <project name>`';
    const project = findProjectByName(config, name);
    if (!project) return `No project found matching "${name}".`;
    const restarted = sessionManager.restartSession(project.channelId);
    if (restarted) return `Session for **${project.name}** restarted — next message will start fresh context.`;
    return `**${project.name}** — no active session to restart.`;
  }

  if (cmd === '!agents') {
    if (!context) return 'Run `!agents` in a project channel or thread.';
    // context.channelId may be a thread ID; look up the project by name
    const match = findProjectByName(config, context.projectName);
    const project = match ? config.projects[match.channelId] : undefined;
    if (!project?.agents || Object.keys(project.agents).length === 0) {
      return `**${context.projectName}** — No agents configured. Messages go to the default session.`;
    }
    const lines = Object.entries(project.agents).map(([name, agent]) =>
      `- \`${name}\` — ${agent.role}`
    );
    return `**${context.projectName} agents**\n${lines.join('\n')}\n\nDispatch: \`!ask <agent> <message>\` or shorthand \`!<agent> <message>\``;
  }

  if (cmd === '!help') {
    const lines = [
      '**Gateway commands**',
      '`!ask <agent> <message>` — dispatch a message to a named agent',
      '`!<agent> <message>` — shorthand for `!ask`',
      '`!sessions` — list all active sessions',
      '`!session` — show session for the current thread (or use `!session <name>`)',
      '`!restart <name>` — reset a session (fresh context, keeps worktree)',
      '`!kill <name>` — force-close a project session',
      '`!agents` — list available agents for the current project',
    ];
    if (handleCuratorCommand) {
      lines.push(
        '`!curator pending` — list pending tier-3 topics for review',
        '`!curator approve <topic|all>` — approve tier-3 content to vault',
        '`!curator reject <topic>` — discard pending tier-3 content',
      );
    }
    lines.push('`!help` — show this message');
    return lines.join('\n');
  }

  return null;
}

const THREAD_HISTORY_LIMIT = 20;

/** Fetch recent thread messages and format as a conversation log. */
async function fetchThreadHistory(channel: TextChannel | ThreadChannel, beforeMessageId: string): Promise<string | null> {
  if (!channel.isThread()) return null;
  try {
    const messages = await channel.messages.fetch({ limit: THREAD_HISTORY_LIMIT, before: beforeMessageId });
    if (messages.size === 0) return null;
    const lines = [...messages.values()]
      .reverse()
      .map((m) => `[${m.author.bot ? 'agent' : m.author.username}]: ${m.content}`);
    return `<thread-history>\n${lines.join('\n')}\n</thread-history>\n\n`;
  } catch {
    return null;
  }
}

/** @internal Use {@link createAdapter} instead — this is the Discord-specific implementation. */
export function createDiscordBot(token: string, router: Router, sessionManager: SessionManager, config: GatewayConfig, turnCounter?: TurnCounter): DiscordBot {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  const rateLimiter = createRateLimiter();

  // Build system prompt with optional Drive context injection (#161)
  async function buildSystemPrompt(agentName: string, agent: AgentConfig): Promise<string> {
    const base = `Your role: ${agent.role}\n\n${agent.prompt}`;
    const threadNameInstruction = '\n\nIMPORTANT: On your FIRST response in a thread, start with a line `THREAD_NAME: <short title>` that summarizes the topic (max 100 chars). This names the Discord thread. Do NOT include this line on subsequent responses.';
    const ctx = await getAgentContext(agentName);
    return ctx ? `${base}${threadNameInstruction}\n\n${ctx}` : `${base}${threadNameInstruction}`;
  }

  // Track last active agent per thread for routing plain replies (#48)
  const lastActiveAgent = new Map<string, { agentName: string; agent: AgentConfig }>();

  // Track threads that have already been named to ensure once-per-lifecycle rename
  const namedThreads = new Set<string>();

  /** If text starts with THREAD_NAME:, rename the thread (once) and return stripped text. */
  async function maybeRenameThread(channel: TextChannel | ThreadChannel, text: string): Promise<string> {
    const threadName = parseThreadName(text);
    if (!threadName) return text;
    const stripped = stripThreadName(text);
    if (channel.isThread() && !namedThreads.has(channel.id)) {
      namedThreads.add(channel.id);
      try {
        await channel.setName(threadName);
      } catch (err) {
        console.error(`Failed to rename thread ${channel.id}:`, err instanceof Error ? err.message : err);
      }
    } else if (!channel.isThread()) {
      // Non-thread channel — just strip the marker, no rename attempt
    } else {
      // Already named — just strip
    }
    return stripped;
  }

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    if (!('send' in message.channel)) return;

    // Handle gateway commands from any mapped channel
    if (message.content.startsWith('!')) {
      const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
      const resolved = router.resolve(message.channelId, parentId);
      if (resolved) {
        // Handle async !curator commands before sync handleCommand
        if (message.content.match(/^!curator\b/i)) {
          if (handleCuratorCommand) {
            const curatorResponse = await handleCuratorCommand(message.content);
            if (curatorResponse) {
              await message.channel.send(curatorResponse);
              return;
            }
          } else {
            await message.channel.send('Curator commands are not available (ayumi module not installed).');
            return;
          }
        }

        const response = handleCommand(message.content, config, sessionManager, {
          channelId: resolved.channelId,
          projectName: resolved.name,
          isThread: resolved.isThread,
        });
        if (response) {
          await message.channel.send(response);
          return;
        }

        // Check for !ask <agent> or !<agent> shorthand dispatch
        const projectChannelId = parentId || resolved.channelId;
        const project = config.projects[projectChannelId];
        const agents = project?.agents;
        if (agents) {
          const askMention = parseAgentCommand(message.content, agents);
          if (askMention) {
            // Fall through to normal message handling — inject the parsed mention
            // by rewriting message content to @agent form so the existing path picks it up
          } else {
            // Check if user tried !ask with an unknown agent name
            const target = extractAskTarget(message.content);
            if (target) {
              const agentList = Object.entries(agents)
                .map(([name, a]) => `\`${name}\` — ${a.role}`)
                .join('\n- ');
              await message.channel.send(
                `Unknown agent \`${target}\`. Available agents:\n- ${agentList}\n\nUsage: \`!ask <agent> <message>\``,
              );
              return;
            }
          }
        }
      }
    }

    const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
    const resolved = router.resolve(message.channelId, parentId);
    if (!resolved) return;

    // Role-based access control
    const projectChannelIdForAcl = parentId || resolved.channelId;
    const projectForAcl = config.projects[projectChannelIdForAcl];
    if (projectForAcl?.allowedRoles && projectForAcl.allowedRoles.length > 0) {
      if (!hasAllowedRole(message.member, projectForAcl.allowedRoles)) {
        await message.reply("You don't have permission to use this bot.");
        return;
      }
    }

    // Per-user rate limiting
    if (projectForAcl?.rateLimitPerUser) {
      const result = rateLimiter.check(`${message.author.id}:${projectChannelIdForAcl}`, projectForAcl.rateLimitPerUser);
      if (!result.allowed) {
        await message.reply(
          `You're sending messages too quickly. Please wait ${result.retryAfterSeconds}s before trying again.`,
        );
        return;
      }
    }

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
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to create thread in ${resolved.name}: ${errMsg}`);
        await message.reply('⚠️ Could not create a thread — check bot permissions (Create Public Threads).');
        return;
      }
    }

    // Show typing indicator while Claude is processing
    const typingInterval = setInterval(() => {
      replyChannel.sendTyping().catch(() => {});
    }, 7_000);
    replyChannel.sendTyping().catch(() => {});

    // Periodic status notifications for long-running worktree sessions (#90)
    const stuckNotifyMs = config.defaults.stuckNotifyMs;
    const isWorktreeSession = replyChannel.isThread();
    const sendStartTime = Date.now();
    let stuckNotifyInterval: ReturnType<typeof setInterval> | null = null;
    if (stuckNotifyMs > 0 && isWorktreeSession) {
      stuckNotifyInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - sendStartTime) / 60_000);
        replyChannel.send(`⏳ Still working… (${elapsed}m elapsed)`).catch(() => {});
      }, stuckNotifyMs);
    }

    // Look up agents for the project (use parent channel ID for threads)
    const projectChannelId = parentId || resolved.channelId;
    const project = config.projects[projectChannelId];
    const agents = project?.agents;

    // Build tool restriction args (per-project overrides gateway defaults).
    // Check both gateway-level and per-project claudeArgs for manual --allowed-tools / --disallowed-tools flags.
    const allClaudeArgs = project?.claudeArgs
      ? [...config.defaults.claudeArgs, ...project.claudeArgs]
      : config.defaults.claudeArgs;
    const toolArgs = buildToolArgs(
      config.defaults,
      project ? { allowedTools: project.allowedTools, disallowedTools: project.disallowedTools } : undefined,
      allClaudeArgs,
    );

    // Reset turn counter on human messages
    if (turnCounter) turnCounter.reset(replyChannel.id);

    // Check for !ask <agent> command, @agent mention, or fall back to last active agent (#48, #60)
    const mention = agents
      ? (parseAgentCommand(message.content, agents) ?? parseAgentMention(message.content, agents))
      : null;
    const activeAgent = mention ?? (message.channel.isThread() ? lastActiveAgent.get(replyChannel.id) ?? null : null);

    // Use thread ID for session keys so each thread gets its own agent sessions.
    // For main-channel messages, replyChannel is the newly created thread.
    const threadId = replyChannel.id;

    // Build session key and system prompt
    const sessionKey = activeAgent
      ? `${threadId}:${activeAgent.agentName}`
      : threadId;
    const systemPrompt = activeAgent
      ? await buildSystemPrompt(activeAgent.agentName, activeAgent.agent)
      : undefined;

    try {
      // Download attachments if present (#110)
      let attachmentPrefix = '';
      if (message.attachments.size > 0) {
        const attachmentConfig: AttachmentConfig = {
          maxAttachmentSizeMb: project?.maxAttachmentSizeMb ?? config.defaults.maxAttachmentSizeMb,
          allowedMimeTypes: project?.allowedMimeTypes ?? config.defaults.allowedMimeTypes,
          maxAttachmentsPerMessage: project?.maxAttachmentsPerMessage ?? config.defaults.maxAttachmentsPerMessage,
        };
        const attachmentResult = await downloadAttachments(
          message.attachments,
          message.id,
          resolved.directory,
          attachmentConfig,
        );
        if (attachmentResult.warnings.length > 0) {
          await replyChannel.send(`⚠️ ${attachmentResult.warnings.join('\n')}`);
        }
        attachmentPrefix = buildAttachmentPrompt(attachmentResult.downloaded);
      }

      // Prepend thread history when dispatching to an agent in a thread (#49)
      let userPrompt = mention ? mention.prompt : message.content;
      if (activeAgent && message.channel.isThread()) {
        const history = await fetchThreadHistory(replyChannel, message.id);
        if (history) userPrompt = `${history}${userPrompt}`;
      }

      // For attachment-only messages, use a default prompt (#110)
      if (!userPrompt.trim() && attachmentPrefix) {
        userPrompt = 'Please review the attached files.';
      }

      // Prepend attachment file references to the prompt
      if (attachmentPrefix) {
        userPrompt = `${attachmentPrefix}${userPrompt}`;
      }

      // Guard against empty prompts (e.g. bare @agent mentions with no attachments)
      if (!userPrompt.trim()) {
        await replyChannel.send('Please include a message with your request.');
        return;
      }

      const primarySpawn = resolveLifeContextRun(activeAgent?.agentName, resolved.directory, toolArgs);
      const result = await sessionManager.send(
        sessionKey,
        primarySpawn.cwd,
        userPrompt,
        {
          worktree: replyChannel.isThread() ? true : undefined,
          systemPrompt,
          timeoutMs: activeAgent ? resolveAgentTimeout(activeAgent.agent, config.defaults) : config.defaults.agentTimeoutMs,
          extraArgs: primarySpawn.extraArgs,
          guildId: message.guildId ?? undefined,
        },
      );

      if (result.sessionReset) {
        await replyChannel.send('⚠️ Previous session expired — starting fresh.');
      } else if (result.sessionChanged) {
        await replyChannel.send('⚠️ Claude started a new session — previous conversation context may be lost.');
      }

      const displayText = await maybeRenameThread(replyChannel, result.text);
      await sendAgentMessage(
        replyChannel,
        displayText,
        activeAgent?.agentName,
        activeAgent?.agent.role,
      );

      // Track last active agent for plain reply routing (#48)
      if (activeAgent) {
        lastActiveAgent.set(threadId, { agentName: activeAgent.agentName, agent: activeAgent.agent });
      }

      // Auto-handoff loop: check if agent response mentions another agent
      if (agents && turnCounter) {
        let responseText = result.text;
        let currentAgentName = activeAgent?.agentName;
        const maxTurns = config.defaults.maxTurnsPerAgent;

        while (true) {
          const allHandoffs = parseAllHandoffs(responseText, agents)
            .filter(h => h.agentName !== currentAgentName);
          if (allHandoffs.length === 0) break;

          // --- Multi-topic fan-out (#157) ---
          if (allHandoffs.length > 1) {
            // Fan-out counts as 1 turn, synthesis as 1 turn = 2 total
            turnCounter.increment(replyChannel.id);
            turnCounter.increment(replyChannel.id);
            const turn = turnCounter.getTurns(replyChannel.id);
            console.log(`[fan-out] thread=${replyChannel.id} turn=${turn}/${maxTurns} ${currentAgentName ?? 'user'} → [${allHandoffs.map(h => h.agentName).join(', ')}]`);

            // Emit agent_handoff pulse events for each fan-out target
            for (const h of allHandoffs) {
              sessionManager.emitHandoff(`${threadId}:${h.agentName}`, resolved.directory, {
                fromAgent: currentAgentName,
                toAgent: h.agentName,
                threadId,
              });
            }

            if (turnCounter.isOverLimit(replyChannel.id, maxTurns)) {
              console.log(`[fan-out] thread=${replyChannel.id} turn limit reached, stopping`);
              await replyChannel.send(`⚠️ Agent turn limit reached (${maxTurns}) — send a message to reset.`);
              break;
            }

            // Announce fan-out
            await replyChannel.send({ embeds: [buildFanOutEmbed(allHandoffs.map(h => h.agentName))] }).catch(() => null);
            replyChannel.sendTyping().catch(() => {});

            // Dispatch all agents in parallel
            const fanOutStart = Date.now();
            const promises = allHandoffs.map(async (handoff) => {
              const key = `${threadId}:${handoff.agentName}`;
              const sysPrompt = await buildSystemPrompt(handoff.agentName, handoff.agent);
              const fanOutTimeout = Math.min(resolveAgentTimeout(handoff.agent, config.defaults), 5 * 60 * 1000);
              const spawn = resolveLifeContextRun(handoff.agentName, resolved.directory, toolArgs);
              return {
                agentName: handoff.agentName,
                result: await sessionManager.send(
                  key, spawn.cwd, responseText,
                  { worktree: replyChannel.isThread() ? true : undefined, systemPrompt: sysPrompt, timeoutMs: fanOutTimeout, extraArgs: spawn.extraArgs },
                ),
              };
            });

            const settled = await Promise.allSettled(promises);
            const fanOutElapsed = ((Date.now() - fanOutStart) / 1000).toFixed(1);
            console.log(`[fan-out] thread=${replyChannel.id} ${settled.length} agents responded in ${fanOutElapsed}s`);

            // Collect results
            const agentResponses: string[] = [];
            for (let i = 0; i < settled.length; i++) {
              const outcome = settled[i];
              const agentName = allHandoffs[i].agentName;
              if (outcome.status === 'fulfilled') {
                agentResponses.push(`<agent-response agent="${agentName}">\n${outcome.value.result.text}\n</agent-response>`);
              } else {
                const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
                console.log(`[fan-out] thread=${replyChannel.id} ${agentName} failed: ${msg}`);
                agentResponses.push(`<agent-response agent="${agentName}">\n[Error: ${msg.slice(0, 500)}]\n</agent-response>`);
              }
            }

            // Send collected responses back to the originating agent for synthesis
            const synthesisPrompt = `The user asked: "${responseText}"\n\nHere are the responses from the topic agents:\n\n${agentResponses.join('\n\n')}\n\nPlease synthesize these into a single coherent answer.`;
            const originKey = `${threadId}:${currentAgentName ?? 'life-router'}`;
            const originAgent = currentAgentName ? agents[currentAgentName] : undefined;
            const originSysPrompt = originAgent ? await buildSystemPrompt(currentAgentName!, originAgent) : undefined;

            replyChannel.sendTyping().catch(() => {});

            let synthesisResult;
            try {
              const synthSpawn = resolveLifeContextRun(currentAgentName ?? undefined, resolved.directory, toolArgs);
              synthesisResult = await sessionManager.send(
                originKey, synthSpawn.cwd, synthesisPrompt,
                { worktree: replyChannel.isThread() ? true : undefined, systemPrompt: originSysPrompt, timeoutMs: originAgent ? resolveAgentTimeout(originAgent, config.defaults) : config.defaults.agentTimeoutMs, extraArgs: synthSpawn.extraArgs },
              );
            } catch (synthErr) {
              const msg = synthErr instanceof Error ? synthErr.message : String(synthErr);
              console.log(`[fan-out] thread=${replyChannel.id} synthesis failed: ${msg}`);
              await replyChannel.send(`⚠️ Synthesis failed: ${msg.slice(0, 1800)}`);
              break;
            }

            const synthElapsed = ((Date.now() - fanOutStart) / 1000).toFixed(1);
            console.log(`[fan-out] thread=${replyChannel.id} synthesis complete in ${synthElapsed}s (${synthesisResult.text.length} chars)`);

            const synthDisplay = await maybeRenameThread(replyChannel, synthesisResult.text);
            await sendAgentMessage(
              replyChannel,
              synthDisplay,
              currentAgentName ?? 'life-router',
              originAgent?.role ?? 'Life Context Router',
            );

            responseText = synthesisResult.text;
            // After synthesis, continue loop to check for further handoffs (unlikely but handled)
            continue;
          }

          // --- Single handoff (existing behavior) ---
          const handoff = allHandoffs[0];
          turnCounter.increment(replyChannel.id);
          const turn = turnCounter.getTurns(replyChannel.id);
          console.log(`[handoff] thread=${replyChannel.id} turn=${turn}/${maxTurns} ${currentAgentName ?? 'user'} → ${handoff.agentName}`);

          // Emit agent_handoff pulse event
          sessionManager.emitHandoff(`${threadId}:${handoff.agentName}`, resolved.directory, {
            fromAgent: currentAgentName,
            toAgent: handoff.agentName,
            threadId,
          });

          if (turnCounter.isOverLimit(replyChannel.id, maxTurns)) {
            console.log(`[handoff] thread=${replyChannel.id} turn limit reached, stopping`);
            await replyChannel.send(
              `⚠️ Agent turn limit reached (${maxTurns}) — send a message to reset.`
            );
            break;
          }

          const handoffKey = `${threadId}:${handoff.agentName}`;
          const handoffPrompt = await buildSystemPrompt(handoff.agentName, handoff.agent);

          replyChannel.sendTyping().catch(() => {});

          // Post handoff announcement — kept visible so users see progress during long agent runs (#56, #65)
          await replyChannel.send({ embeds: [buildHandoffEmbed(handoff.agentName, handoff.agent.role)] }).catch(() => null);

          // Restore typing indicator — posting the announcement clears it (#65)
          replyChannel.sendTyping().catch(() => {});

          console.log(`[handoff] thread=${replyChannel.id} sending to ${handoff.agentName} (key=${handoffKey}, prompt length=${responseText.length})`);
          const sendStart = Date.now();

          let handoffResult;
          try {
            const handoffSpawn = resolveLifeContextRun(handoff.agentName, resolved.directory, toolArgs);
            handoffResult = await sessionManager.send(
              handoffKey,
              handoffSpawn.cwd,
              responseText,
              { worktree: replyChannel.isThread() ? true : undefined, systemPrompt: handoffPrompt, timeoutMs: resolveAgentTimeout(handoff.agent, config.defaults), extraArgs: handoffSpawn.extraArgs },
            );
          } catch (handoffErr) {
            const msg = handoffErr instanceof Error ? handoffErr.message : String(handoffErr);
            console.log(`[handoff] thread=${replyChannel.id} ${handoff.agentName} failed: ${msg}`);
            await replyChannel.send(
              `⚠️ Agent \`@${handoff.agentName}\` failed: ${msg.slice(0, 1800)}`
            );
            break;
          }

          const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
          console.log(`[handoff] thread=${replyChannel.id} ${handoff.agentName} responded in ${elapsed}s (${handoffResult.text.length} chars)`);

          const handoffDisplay = await maybeRenameThread(replyChannel, handoffResult.text);
          await sendAgentMessage(
            replyChannel,
            handoffDisplay,
            handoff.agentName,
            handoff.agent.role,
          );

          responseText = handoffResult.text;
          currentAgentName = handoff.agentName;
          lastActiveAgent.set(threadId, { agentName: handoff.agentName, agent: handoff.agent });
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await replyChannel.send(
        `**Error** (${resolved.name}): ${errorMsg.slice(0, 1800)}`,
      );
    } finally {
      clearInterval(typingInterval);
      if (stuckNotifyInterval) clearInterval(stuckNotifyInterval);
    }
  });

  return {
    async start() {
      await client.login(token);
      console.log(`Gateway connected as ${client.user?.tag}`);
    },
    stop() {
      rateLimiter.dispose();
      client.destroy();
    },
    getGuildId(): string | null {
      const first = client.guilds.cache.first();
      return first?.id ?? null;
    },
    getStatus(): string {
      const ws = client.ws;
      const statusMap: Record<number, string> = {
        [Status.Ready]: 'connected',
        [Status.Connecting]: 'connecting',
        [Status.Reconnecting]: 'reconnecting',
        [Status.Idle]: 'idle',
        [Status.Nearly]: 'nearly',
        [Status.Disconnected]: 'disconnected',
        [Status.WaitingForGuilds]: 'waiting_for_guilds',
        [Status.Identifying]: 'identifying',
        [Status.Resuming]: 'resuming',
      };
      return statusMap[ws.status] ?? 'unknown';
    },
    async deliverOrphanResult(projectKey: string, result: import('./claude-cli.js').ClaudeResult): Promise<void> {
      // projectKey is "threadId" or "threadId:agentName"
      const threadId = projectKey.includes(':') ? projectKey.split(':')[0] : projectKey;
      const agentName = projectKey.includes(':') ? projectKey.split(':').pop() : undefined;

      try {
        const channel = await client.channels.fetch(threadId);
        if (!channel || !('send' in channel)) {
          console.error(`Cannot deliver orphan result: channel ${threadId} not found or not sendable`);
          return;
        }

        // Look up agent role if this was an agent session
        let agentRole: string | undefined;
        if (agentName && channel.isThread() && channel.parentId) {
          const project = config.projects[channel.parentId];
          agentRole = project?.agents?.[agentName]?.role;
        }

        await channel.send('🔄 Resumed after gateway restart — here is the pending response:');
        const orphanDisplay = await maybeRenameThread(channel as TextChannel | ThreadChannel, result.text);
        await sendAgentMessage(channel as TextChannel | ThreadChannel, orphanDisplay, agentName, agentRole);
      } catch (err) {
        console.error(`Failed to deliver orphan result to ${threadId}:`, err);
      }
    },
  };
}
