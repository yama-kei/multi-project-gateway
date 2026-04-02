/**
 * Loads life-context data from Google Drive for topic agents.
 * Maps agent names (life-work, life-travel, etc.) to Drive topics
 * and fetches summary.md, timeline.md, entities.md files.
 *
 * Navigates the Drive folder tree directly:
 *   driveSearch("life-context") → driveList(life-context/) → find topic folder
 *   → driveList(topic/) → driveRead(files)
 *
 * This avoids depending on folder-map.json (which requires metadata cache
 * priming that the broker's search endpoint doesn't provide).
 */

import { createBrokerClient, type BrokerClient } from '../broker-client.js';
import type { TopicName } from './life-context-setup.js';

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

// Cache the life-context folder ID and its topic subfolder IDs across calls
let lifeContextFolderId: string | null = null;
let topicFolderIds: Record<string, string> | null = null;

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

/**
 * Discover the topic folder ID by navigating the Drive tree:
 * 1. Search for "life-context" folder
 * 2. List its children to find topic subfolders
 * 3. Return the folder ID for the requested topic
 */
async function resolveTopicFolderId(client: BrokerClient, topic: string): Promise<string | null> {
  // Use cached topic folder IDs if available
  if (topicFolderIds) {
    return topicFolderIds[topic] ?? null;
  }

  // Find the life-context folder
  if (!lifeContextFolderId) {
    const searchResult = await client.driveSearch('life-context');
    const lcFolder = searchResult.files.find(
      (f) => f.name === 'life-context' && f.mime_type === 'application/vnd.google-apps.folder',
    );
    if (!lcFolder) {
      console.error('[life-context-loader] life-context folder not found in Drive');
      return null;
    }
    lifeContextFolderId = lcFolder.file_id;
  }

  // List life-context/ to discover topic subfolders (also primes metadata cache)
  const listing = await client.driveList(lifeContextFolderId);
  topicFolderIds = {};
  for (const file of listing.files) {
    if (file.mime_type === 'application/vnd.google-apps.folder') {
      topicFolderIds[file.name] = file.file_id;
    }
  }

  return topicFolderIds[topic] ?? null;
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
    const folderId = await resolveTopicFolderId(client, topic);
    if (!folderId) {
      console.error(`[life-context-loader] No folder found for topic "${topic}" in Drive`);
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
  lifeContextFolderId = null;
  topicFolderIds = null;
}
