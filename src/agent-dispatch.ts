// src/agent-dispatch.ts
import type { AgentConfig } from './config.js';

export type { AgentConfig };

export interface AgentMention {
  agentName: string;
  agent: AgentConfig;
  prompt: string;
}

/** Built-in command names that take precedence over agent shorthand (!<agent>). */
const BUILT_IN_COMMANDS = new Set([
  'help', 'sessions', 'session', 'kill', 'restart', 'agents', 'ask',
]);

/**
 * Parse `!ask <agent> <message>` (canonical) or `!<agent> <message>` (shorthand).
 * Shorthand yields to built-in commands — e.g. `!help` is never treated as an agent dispatch.
 */
export function parseAgentCommand(
  text: string,
  agents: Record<string, AgentConfig>,
): AgentMention | null {
  // Canonical form: !ask <agent> <message>
  const askMatch = text.match(/^!ask\s+(\S+)(?:\s+([\s\S]*))?$/i);
  if (askMatch) {
    const name = askMatch[1].toLowerCase();
    const agent = agents[name];
    if (!agent) return null; // unknown agent — caller handles error
    const prompt = (askMatch[2] ?? '').trim();
    return { agentName: name, agent, prompt };
  }

  // Shorthand form: !<agent> <message> (only if not a built-in command)
  const shortMatch = text.match(/^!(\S+)(?:\s+([\s\S]*))?$/i);
  if (shortMatch) {
    const name = shortMatch[1].toLowerCase();
    if (BUILT_IN_COMMANDS.has(name)) return null; // built-in wins
    const agent = agents[name];
    if (!agent) return null;
    const prompt = (shortMatch[2] ?? '').trim();
    return { agentName: name, agent, prompt };
  }

  return null;
}

/**
 * Extract the target agent name from a `!ask` command, even if the agent is unknown.
 * Returns null if the message is not a `!ask` command at all.
 */
export function extractAskTarget(text: string): string | null {
  const askMatch = text.match(/^!ask\s+(\S+)/i);
  return askMatch ? askMatch[1].toLowerCase() : null;
}

export function parseAgentMention(
  text: string,
  agents: Record<string, AgentConfig>,
): AgentMention | null {
  // Build a pattern that matches @agentName (case-insensitive)
  const agentNames = Object.keys(agents);
  if (agentNames.length === 0) return null;

  const escaped = agentNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`@(${escaped.join('|')})\\b`, 'i');
  const match = text.match(pattern);
  if (!match) return null;

  const matchedName = match[1].toLowerCase();
  const agent = agents[matchedName];
  if (!agent) return null;

  // If mention is at the start, strip it from the prompt
  let prompt: string;
  if (match.index === 0) {
    prompt = text.slice(match[0].length).trim();
  } else {
    prompt = text;
  }

  return { agentName: matchedName, agent, prompt };
}
