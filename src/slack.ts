import { App } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';
import type { Router } from './router.js';
import type { SessionManager } from './session-manager.js';
import { type GatewayConfig, resolveAgentTimeout } from './config.js';
import { buildToolArgs } from './claude-cli.js';
import { parseAgentMention, parseAgentCommand, extractAskTarget, parseAllHandoffs, parseThreadName, stripThreadName } from './agent-dispatch.js';
import type { TurnCounter } from './turn-counter.js';
import type { ChannelAdapter } from './adapter.js';
import { createRateLimiter } from './rate-limiter.js';
import type { AgentConfig } from './config.js';
import { handleCommand } from './discord.js';

// Ayumi life-context module — optional, gracefully absent
let getAgentContext: (agentName: string) => Promise<string | null> = async () => null;
try {
  const ayumi = await import('./ayumi/index.js');
  getAgentContext = ayumi.getAgentContext;
} catch {
  // Ayumi module not available — no life context injection
}

/** Slack message text limit (~4000 chars, with margin). */
const SLACK_TEXT_LIMIT = 3900;

/** Number of recent thread messages to fetch for context. */
const THREAD_HISTORY_LIMIT = 20;

export function chunkSlackMessage(text: string, limit: number = SLACK_TEXT_LIMIT): string[] {
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

/** Send a chunked message to a Slack channel/thread. */
async function sendSlackMessage(
  app: App,
  channel: string,
  text: string,
  threadTs?: string,
  agentName?: string,
  agentRole?: string,
): Promise<void> {
  const prefix = agentName && agentRole ? `*${agentRole}* (\`@${agentName}\`):\n` : '';
  const fullText = prefix + text;
  const chunks = chunkSlackMessage(fullText);
  for (const chunk of chunks) {
    await app.client.chat.postMessage({
      channel,
      text: chunk,
      thread_ts: threadTs,
    });
  }
}

/** Fetch recent thread messages for context. */
async function fetchThreadHistory(
  app: App,
  channel: string,
  threadTs: string,
): Promise<string | null> {
  try {
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: THREAD_HISTORY_LIMIT,
    });
    const messages = result.messages;
    if (!messages || messages.length <= 1) return null; // Only the parent message
    // Skip the last message (the one we're responding to)
    const history = messages.slice(0, -1);
    const lines = history.map((m) => {
      const isBot = !!m.bot_id;
      const user = isBot ? 'agent' : (m.user ?? 'unknown');
      return `[${user}]: ${m.text ?? ''}`;
    });
    return `<thread-history>\n${lines.join('\n')}\n</thread-history>\n\n`;
  } catch {
    return null;
  }
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

export interface SlackBot extends ChannelAdapter {
  // SlackBot is a ChannelAdapter — no extra methods for now
}

export function createSlackBot(
  botToken: string,
  appToken: string,
  router: Router,
  sessionManager: SessionManager,
  config: GatewayConfig,
  turnCounter?: TurnCounter,
): SlackBot {
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  const rateLimiter = createRateLimiter();

  // Build system prompt with optional life-context injection
  async function buildSystemPrompt(agentName: string, agent: AgentConfig): Promise<string> {
    const base = `Your role: ${agent.role}\n\n${agent.prompt}`;
    const threadNameInstruction = '\n\nIMPORTANT: On your FIRST response in a thread, start with a line `THREAD_NAME: <short title>` that summarizes the topic (max 100 chars). Do NOT include this line on subsequent responses.';
    const ctx = await getAgentContext(agentName);
    return ctx ? `${base}${threadNameInstruction}\n\n${ctx}` : `${base}${threadNameInstruction}`;
  }

  // Track last active agent per thread for routing plain replies
  const lastActiveAgent = new Map<string, { agentName: string; agent: AgentConfig }>();

  // Track threads that have had their first message (THREAD_NAME: is stripped but not used for renaming in Slack)
  const namedThreads = new Set<string>();

  /** Strip THREAD_NAME: marker from text. Slack threads can't be renamed, so just strip. */
  function maybeStripThreadName(threadKey: string, text: string): string {
    const threadName = parseThreadName(text);
    if (!threadName) return text;
    namedThreads.add(threadKey);
    return stripThreadName(text);
  }

  let status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';

  // Register message handler
  app.message(async ({ message, say }) => {
    // Only handle generic messages (not subtypes like message_changed, etc.)
    const msg = message as GenericMessageEvent;
    if (msg.subtype) return;
    if (msg.bot_id) return; // Ignore bot messages
    if (!msg.text) return;

    const channelId = msg.channel;
    const threadTs = msg.thread_ts; // undefined if top-level, set if in a thread
    const isThread = !!threadTs;

    // Resolve the channel to a project
    // For thread messages, the channel is still the parent channel in Slack
    const resolved = router.resolve(channelId);
    if (!resolved) return;

    // Handle gateway commands
    if (msg.text.startsWith('!')) {
      // Handle async !curator commands
      if (msg.text.match(/^!curator\b/i)) {
        try {
          const { handleCuratorCommand } = await import('./ayumi/curator-commands.js');
          const curatorResponse = await handleCuratorCommand(msg.text);
          if (curatorResponse) {
            await say({ text: curatorResponse, thread_ts: threadTs ?? msg.ts });
            return;
          }
        } catch {
          await say({ text: 'Curator commands are not available (ayumi module not installed).', thread_ts: threadTs ?? msg.ts });
          return;
        }
      }

      const response = handleCommand(msg.text, config, sessionManager, {
        channelId: resolved.channelId,
        projectName: resolved.name,
        isThread: resolved.isThread || isThread,
      });
      if (response) {
        await say({ text: response, thread_ts: threadTs ?? msg.ts });
        return;
      }

      // Check for !ask <agent> or !<agent> shorthand
      const project = config.projects[channelId];
      const agents = project?.agents;
      if (agents) {
        const askMention = parseAgentCommand(msg.text, agents);
        if (!askMention) {
          const target = extractAskTarget(msg.text);
          if (target) {
            const agentList = Object.entries(agents)
              .map(([name, a]) => `\`${name}\` — ${a.role}`)
              .join('\n- ');
            await say({
              text: `Unknown agent \`${target}\`. Available agents:\n- ${agentList}\n\nUsage: \`!ask <agent> <message>\``,
              thread_ts: threadTs ?? msg.ts,
            });
            return;
          }
        }
      }
    }

    // Rate limiting
    const project = config.projects[channelId];
    if (project?.rateLimitPerUser) {
      const result = rateLimiter.check(`${msg.user}:${channelId}`, project.rateLimitPerUser);
      if (!result.allowed) {
        await say({
          text: `You're sending messages too quickly. Please wait ${result.retryAfterSeconds}s before trying again.`,
          thread_ts: threadTs ?? msg.ts,
        });
        return;
      }
    }

    // For top-level messages, we'll reply in a thread (using the message's ts as thread_ts).
    // For thread replies, continue in the same thread.
    const replyThreadTs = threadTs ?? msg.ts;

    // Periodic stuck notifications
    const stuckNotifyMs = config.defaults.stuckNotifyMs;
    const sendStartTime = Date.now();
    let stuckNotifyInterval: ReturnType<typeof setInterval> | null = null;
    if (stuckNotifyMs > 0) {
      stuckNotifyInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - sendStartTime) / 60_000);
        app.client.chat.postMessage({
          channel: channelId,
          text: `⏳ Still working… (${elapsed}m elapsed)`,
          thread_ts: replyThreadTs,
        }).catch(() => {});
      }, stuckNotifyMs);
    }

    // Look up agents for the project
    const agents = project?.agents;

    // Build tool restriction args
    const allClaudeArgs = project?.claudeArgs
      ? [...config.defaults.claudeArgs, ...project.claudeArgs]
      : config.defaults.claudeArgs;
    const toolArgs = buildToolArgs(
      config.defaults,
      project ? { allowedTools: project.allowedTools, disallowedTools: project.disallowedTools } : undefined,
      allClaudeArgs,
    );

    // Reset turn counter on human messages
    if (turnCounter) turnCounter.reset(replyThreadTs);

    // Check for agent dispatch
    const mention = agents
      ? (parseAgentCommand(msg.text, agents) ?? parseAgentMention(msg.text, agents))
      : null;
    const activeAgent = mention ?? (isThread ? lastActiveAgent.get(replyThreadTs) ?? null : null);

    // Session key: use thread_ts (or message ts for new threads) + optional agent name
    const sessionKey = activeAgent
      ? `${replyThreadTs}:${activeAgent.agentName}`
      : replyThreadTs;
    const systemPrompt = activeAgent
      ? await buildSystemPrompt(activeAgent.agentName, activeAgent.agent)
      : undefined;

    try {
      // Prepend thread history when dispatching to an agent in a thread
      let userPrompt = mention ? mention.prompt : msg.text;
      if (activeAgent && isThread) {
        const history = await fetchThreadHistory(app, channelId, replyThreadTs);
        if (history) userPrompt = `${history}${userPrompt}`;
      }

      // Guard against empty prompts
      if (!userPrompt.trim()) {
        await say({ text: 'Please include a message with your request.', thread_ts: replyThreadTs });
        return;
      }

      const result = await sessionManager.send(
        sessionKey,
        resolved.directory,
        userPrompt,
        {
          worktree: isThread ? true : undefined,
          systemPrompt,
          timeoutMs: activeAgent ? resolveAgentTimeout(activeAgent.agent, config.defaults) : config.defaults.agentTimeoutMs,
          extraArgs: toolArgs.length > 0 ? toolArgs : undefined,
        },
      );

      if (result.sessionReset) {
        await app.client.chat.postMessage({
          channel: channelId,
          text: '⚠️ Previous session expired — starting fresh.',
          thread_ts: replyThreadTs,
        });
      } else if (result.sessionChanged) {
        await app.client.chat.postMessage({
          channel: channelId,
          text: '⚠️ Claude started a new session — previous conversation context may be lost.',
          thread_ts: replyThreadTs,
        });
      }

      const displayText = maybeStripThreadName(replyThreadTs, result.text);
      await sendSlackMessage(app, channelId, displayText, replyThreadTs, activeAgent?.agentName, activeAgent?.agent.role);

      // Track last active agent for plain reply routing
      if (activeAgent) {
        lastActiveAgent.set(replyThreadTs, { agentName: activeAgent.agentName, agent: activeAgent.agent });
      }

      // Auto-handoff loop
      if (agents && turnCounter) {
        let responseText = result.text;
        let currentAgentName = activeAgent?.agentName;
        const maxTurns = config.defaults.maxTurnsPerAgent;

        while (true) {
          const allHandoffs = parseAllHandoffs(responseText, agents)
            .filter(h => h.agentName !== currentAgentName);
          if (allHandoffs.length === 0) break;

          // --- Multi-topic fan-out ---
          if (allHandoffs.length > 1) {
            turnCounter.increment(replyThreadTs);
            turnCounter.increment(replyThreadTs);
            const turn = turnCounter.getTurns(replyThreadTs);
            console.log(`[slack:fan-out] thread=${replyThreadTs} turn=${turn}/${maxTurns} ${currentAgentName ?? 'user'} → [${allHandoffs.map(h => h.agentName).join(', ')}]`);

            for (const h of allHandoffs) {
              sessionManager.emitHandoff(`${replyThreadTs}:${h.agentName}`, resolved.directory, {
                fromAgent: currentAgentName,
                toAgent: h.agentName,
                threadId: replyThreadTs,
              });
            }

            if (turnCounter.isOverLimit(replyThreadTs, maxTurns)) {
              console.log(`[slack:fan-out] thread=${replyThreadTs} turn limit reached, stopping`);
              await app.client.chat.postMessage({
                channel: channelId,
                text: `⚠️ Agent turn limit reached (${maxTurns}) — send a message to reset.`,
                thread_ts: replyThreadTs,
              });
              break;
            }

            // Announce fan-out
            const fanOutList = allHandoffs.map(h => `\`@${h.agentName}\``).join(', ');
            await app.client.chat.postMessage({
              channel: channelId,
              text: `Dispatching to ${allHandoffs.length} agents: ${fanOutList}...`,
              thread_ts: replyThreadTs,
            }).catch(() => null);

            // Dispatch all agents in parallel
            const fanOutStart = Date.now();
            const promises = allHandoffs.map(async (handoff) => {
              const key = `${replyThreadTs}:${handoff.agentName}`;
              const sysPrompt = await buildSystemPrompt(handoff.agentName, handoff.agent);
              const fanOutTimeout = Math.min(resolveAgentTimeout(handoff.agent, config.defaults), 5 * 60 * 1000);
              return {
                agentName: handoff.agentName,
                result: await sessionManager.send(
                  key, resolved.directory, responseText,
                  { worktree: true, systemPrompt: sysPrompt, timeoutMs: fanOutTimeout, extraArgs: toolArgs.length > 0 ? toolArgs : undefined },
                ),
              };
            });

            const settled = await Promise.allSettled(promises);
            const fanOutElapsed = ((Date.now() - fanOutStart) / 1000).toFixed(1);
            console.log(`[slack:fan-out] thread=${replyThreadTs} ${settled.length} agents responded in ${fanOutElapsed}s`);

            const agentResponses: string[] = [];
            for (let i = 0; i < settled.length; i++) {
              const outcome = settled[i];
              const agentName = allHandoffs[i].agentName;
              if (outcome.status === 'fulfilled') {
                agentResponses.push(`<agent-response agent="${agentName}">\n${outcome.value.result.text}\n</agent-response>`);
              } else {
                const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
                console.log(`[slack:fan-out] thread=${replyThreadTs} ${agentName} failed: ${errMsg}`);
                agentResponses.push(`<agent-response agent="${agentName}">\n[Error: ${errMsg.slice(0, 500)}]\n</agent-response>`);
              }
            }

            // Synthesis
            const synthesisPrompt = `The user asked: "${responseText}"\n\nHere are the responses from the topic agents:\n\n${agentResponses.join('\n\n')}\n\nPlease synthesize these into a single coherent answer.`;
            const originKey = `${replyThreadTs}:${currentAgentName ?? 'life-router'}`;
            const originAgent = currentAgentName ? agents[currentAgentName] : undefined;
            const originSysPrompt = originAgent ? await buildSystemPrompt(currentAgentName!, originAgent) : undefined;

            let synthesisResult;
            try {
              synthesisResult = await sessionManager.send(
                originKey, resolved.directory, synthesisPrompt,
                { worktree: true, systemPrompt: originSysPrompt, timeoutMs: originAgent ? resolveAgentTimeout(originAgent, config.defaults) : config.defaults.agentTimeoutMs, extraArgs: toolArgs.length > 0 ? toolArgs : undefined },
              );
            } catch (synthErr) {
              const errMsg = synthErr instanceof Error ? synthErr.message : String(synthErr);
              console.log(`[slack:fan-out] thread=${replyThreadTs} synthesis failed: ${errMsg}`);
              await app.client.chat.postMessage({
                channel: channelId,
                text: `⚠️ Synthesis failed: ${errMsg.slice(0, 1800)}`,
                thread_ts: replyThreadTs,
              });
              break;
            }

            const synthDisplay = maybeStripThreadName(replyThreadTs, synthesisResult.text);
            await sendSlackMessage(
              app, channelId, synthDisplay, replyThreadTs,
              currentAgentName ?? 'life-router',
              originAgent?.role ?? 'Life Context Router',
            );

            responseText = synthesisResult.text;
            continue;
          }

          // --- Single handoff ---
          const handoff = allHandoffs[0];
          turnCounter.increment(replyThreadTs);
          const turn = turnCounter.getTurns(replyThreadTs);
          console.log(`[slack:handoff] thread=${replyThreadTs} turn=${turn}/${maxTurns} ${currentAgentName ?? 'user'} → ${handoff.agentName}`);

          sessionManager.emitHandoff(`${replyThreadTs}:${handoff.agentName}`, resolved.directory, {
            fromAgent: currentAgentName,
            toAgent: handoff.agentName,
            threadId: replyThreadTs,
          });

          if (turnCounter.isOverLimit(replyThreadTs, maxTurns)) {
            console.log(`[slack:handoff] thread=${replyThreadTs} turn limit reached, stopping`);
            await app.client.chat.postMessage({
              channel: channelId,
              text: `⚠️ Agent turn limit reached (${maxTurns}) — send a message to reset.`,
              thread_ts: replyThreadTs,
            });
            break;
          }

          const handoffKey = `${replyThreadTs}:${handoff.agentName}`;
          const handoffPrompt = await buildSystemPrompt(handoff.agentName, handoff.agent);

          // Announce handoff
          await app.client.chat.postMessage({
            channel: channelId,
            text: `Handing off to *@${handoff.agentName}*...`,
            thread_ts: replyThreadTs,
          }).catch(() => null);

          console.log(`[slack:handoff] thread=${replyThreadTs} sending to ${handoff.agentName} (key=${handoffKey}, prompt length=${responseText.length})`);
          const sendStart = Date.now();

          let handoffResult;
          try {
            handoffResult = await sessionManager.send(
              handoffKey,
              resolved.directory,
              responseText,
              { worktree: true, systemPrompt: handoffPrompt, timeoutMs: resolveAgentTimeout(handoff.agent, config.defaults), extraArgs: toolArgs.length > 0 ? toolArgs : undefined },
            );
          } catch (handoffErr) {
            const errMsg = handoffErr instanceof Error ? handoffErr.message : String(handoffErr);
            console.log(`[slack:handoff] thread=${replyThreadTs} ${handoff.agentName} failed: ${errMsg}`);
            await app.client.chat.postMessage({
              channel: channelId,
              text: `⚠️ Agent \`@${handoff.agentName}\` failed: ${errMsg.slice(0, 1800)}`,
              thread_ts: replyThreadTs,
            });
            break;
          }

          const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
          console.log(`[slack:handoff] thread=${replyThreadTs} ${handoff.agentName} responded in ${elapsed}s (${handoffResult.text.length} chars)`);

          const handoffDisplay = maybeStripThreadName(replyThreadTs, handoffResult.text);
          await sendSlackMessage(
            app, channelId, handoffDisplay, replyThreadTs,
            handoff.agentName,
            handoff.agent.role,
          );

          responseText = handoffResult.text;
          currentAgentName = handoff.agentName;
          lastActiveAgent.set(replyThreadTs, { agentName: handoff.agentName, agent: handoff.agent });
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await app.client.chat.postMessage({
        channel: channelId,
        text: `**Error** (${resolved.name}): ${errorMsg.slice(0, 1800)}`,
        thread_ts: replyThreadTs,
      });
    } finally {
      if (stuckNotifyInterval) clearInterval(stuckNotifyInterval);
    }
  });

  return {
    async start() {
      status = 'connecting';
      await app.start();
      status = 'connected';
      console.log('Gateway connected to Slack via Socket Mode');
    },
    stop() {
      rateLimiter.dispose();
      app.stop().catch((err) => {
        console.error('Error stopping Slack app:', err);
      });
      status = 'disconnected';
    },
    getStatus(): string {
      return status;
    },
    async deliverOrphanResult(projectKey: string, result: import('./claude-cli.js').ClaudeResult): Promise<void> {
      // projectKey is "threadTs" or "threadTs:agentName"
      const threadTs = projectKey.includes(':') ? projectKey.split(':')[0] : projectKey;
      const agentName = projectKey.includes(':') ? projectKey.split(':').pop() : undefined;

      // We need the channel ID to post. Try to find it from config projects.
      // In Slack, thread_ts alone isn't enough — we need the channel.
      // For now, attempt delivery to all configured channels (one will match).
      for (const channelIdCandidate of Object.keys(config.projects)) {
        try {
          // Check if this thread exists in this channel
          const replies = await app.client.conversations.replies({
            channel: channelIdCandidate,
            ts: threadTs,
            limit: 1,
          });
          if (!replies.messages || replies.messages.length === 0) continue;

          let agentRole: string | undefined;
          if (agentName) {
            const project = config.projects[channelIdCandidate];
            agentRole = project?.agents?.[agentName]?.role;
          }

          await app.client.chat.postMessage({
            channel: channelIdCandidate,
            text: '🔄 Resumed after gateway restart — here is the pending response:',
            thread_ts: threadTs,
          });

          const orphanDisplay = maybeStripThreadName(threadTs, result.text);
          await sendSlackMessage(app, channelIdCandidate, orphanDisplay, threadTs, agentName, agentRole);
          return; // Delivered successfully
        } catch {
          // Not in this channel, try next
        }
      }
      console.error(`Cannot deliver orphan result: thread ${threadTs} not found in any configured channel`);
    },
  };
}
