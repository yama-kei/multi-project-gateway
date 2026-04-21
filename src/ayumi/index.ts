/**
 * Ayumi life-context module — single entry point.
 *
 * MPG core should only import from this file. Everything else
 * in src/ayumi/ is an internal implementation detail.
 *
 * Pipeline primitives (fetchUrl, extractContent, summarizeContent,
 * createVaultWriter, createDriveBroker, etc.) are available via
 * `import { ... } from 'ayumi'` directly.
 */

import { loadLifeContext, getLifeContextRunArgs } from './life-context-loader.js';

export { loadLifeContext, getLifeContextRunArgs };
export type { LifeContextRunArgs } from './life-context-loader.js';

// Re-export ayumi pipeline primitives that other MPG modules may need
export type { Topic, DriveBroker, ExtractedContent, ClassificationResult, ArticleSummary, LLMComplete } from 'ayumi';
export { fetchUrl, extractContent, classifyContent, summarizeContent, createVaultWriter, createDriveBroker, parseFile } from 'ayumi';

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

/**
 * Curator approval commands for tier-3 content.
 */
export { handleCuratorCommand } from './curator-commands.js';
