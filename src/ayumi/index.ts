/**
 * Ayumi life-context module — single entry point.
 *
 * MPG core should only import from this file. Everything else
 * in src/ayumi/ is an internal implementation detail.
 */

import { loadLifeContext } from './life-context-loader.js';
import type { AgentConfig } from '../config.js';

export { loadLifeContext };

/**
 * Get agent context for the given agent name.
 * Returns formatted context string to append to the system prompt,
 * or null if this agent doesn't use life context.
 */
export async function getAgentContext(agentName: string): Promise<string | null> {
  return loadLifeContext(agentName);
}

/**
 * Ayumi-specific persona presets (life-router, life-work, etc.).
 * Loaded lazily so the preset registry can merge them at startup.
 */
export { AYUMI_PRESETS } from './presets.js';
