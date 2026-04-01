/**
 * Loads life-context data from Google Drive for topic agents.
 * Maps agent names (life-work, life-travel, etc.) to Drive topics
 * and fetches summary.md, timeline.md, entities.md files.
 */

import { createBrokerClient, type BrokerClient } from '../broker-client.js';
import type { FolderMap, TopicName } from './life-context-setup.js';

const AGENT_TOPIC_MAP: Record<string, TopicName> = {
  'life-work': 'work',
  'life-travel': 'travel',
  'life-social': 'social',
  'life-hobbies': 'hobbies',
};

const CONTEXT_FILES = ['summary.md', 'timeline.md', 'entities.md'] as const;

// Module-level singleton broker client
let brokerClient: BrokerClient | null = null;
let envWarned = false;

function getOrCreateClient(): BrokerClient | null {
  if (brokerClient) return brokerClient;

  const { BROKER_URL, BROKER_API_SECRET, BROKER_TENANT_ID, BROKER_ACTOR_ID } = process.env;
  if (!BROKER_URL || !BROKER_API_SECRET || !BROKER_TENANT_ID || !BROKER_ACTOR_ID) {
    if (!envWarned) {
      console.warn('[life-context-loader] Missing broker env vars (BROKER_URL, BROKER_API_SECRET, BROKER_TENANT_ID, BROKER_ACTOR_ID) — Drive context will not be loaded');
      envWarned = true;
    }
    return null;
  }

  brokerClient = createBrokerClient({
    brokerUrl: BROKER_URL,
    apiSecret: BROKER_API_SECRET,
    tenantId: BROKER_TENANT_ID,
    actorId: BROKER_ACTOR_ID,
  });
  return brokerClient;
}

async function loadFolderMap(client: BrokerClient): Promise<FolderMap | null> {
  const searchResult = await client.driveSearch('folder-map.json');
  const mapFile = searchResult.files.find((f) => f.name === 'folder-map.json');
  if (!mapFile) return null;
  const content = await client.driveRead(mapFile.file_id);
  return JSON.parse(content.content) as FolderMap;
}

/**
 * Load life-context files from Drive for the given agent.
 *
 * @param agentName Agent preset name (e.g., 'life-work', 'life-travel')
 * @returns Formatted context string, or null if not a life-context agent or loading fails
 */
export async function loadLifeContext(agentName: string): Promise<string | null> {
  const topic = AGENT_TOPIC_MAP[agentName];
  if (!topic) return null;

  const client = getOrCreateClient();
  if (!client) return null;

  try {
    const folderMap = await loadFolderMap(client);
    if (!folderMap) {
      console.error('[life-context-loader] folder-map.json not found in Drive');
      return null;
    }

    const folderId = folderMap.topics[topic];
    if (!folderId) {
      console.error(`[life-context-loader] No folder ID for topic "${topic}" in folder-map`);
      return null;
    }

    const listing = await client.driveList(folderId);
    if (listing.files.length === 0) {
      console.warn(`[life-context-loader] No files in ${topic} folder`);
      return null;
    }

    const sections: string[] = [];
    for (const filename of CONTEXT_FILES) {
      const file = listing.files.find((f) => f.name === filename);
      if (!file) continue;

      const result = await client.driveRead(file.file_id);
      sections.push(`## ${filename}\n${result.content}`);
    }

    if (sections.length === 0) return null;

    return `--- LIFE CONTEXT DATA ---\n\n${sections.join('\n\n')}\n\n--- END LIFE CONTEXT DATA ---`;
  } catch (err) {
    console.error(`[life-context-loader] Error loading context for ${agentName}:`, err);
    return null;
  }
}

/** Reset module-level state (for testing). */
export function _resetForTest(): void {
  brokerClient = null;
  envWarned = false;
}
