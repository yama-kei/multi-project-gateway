// src/agent-dispatch.ts
import type { AgentConfig } from './config.js';

export type { AgentConfig };

export interface AgentMention {
  agentName: string;
  agent: AgentConfig;
  prompt: string;
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
