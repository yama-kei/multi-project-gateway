/**
 * Loads life-context data from Google Drive for topic agents.
 * Maps agent names (life-work, life-travel, etc.) to Drive topics
 * and reads all .md files from each topic folder dynamically.
 *
 * Navigates the Drive folder tree directly:
 *   driveSearch("life-context") → driveList(life-context/) → find topic folder
 *   → driveList(topic/) → driveRead(all .md files)
 *
 * Files are sorted by modified date (newest first). A per-topic size budget
 * ensures context doesn't exceed token limits — oldest content is dropped first.
 */

import { createBrokerClient, type BrokerClient, type DriveFile } from '../broker-client.js';
import type { TopicName } from './life-context-setup.js';

const AGENT_TOPIC_MAP: Record<string, TopicName> = {
  'life-work': 'work',
  'life-travel': 'travel',
  'life-social': 'social',
  'life-hobbies': 'hobbies',
};

/** Maximum bytes of context content per topic before truncation. */
export const DEFAULT_TOPIC_SIZE_BUDGET = 8 * 1024; // 8 KB

/** Re-resolve folder IDs after this many milliseconds (5 minutes). */
const FOLDER_CACHE_TTL_MS = 5 * 60 * 1000;

// Module-level singleton broker client
let brokerClient: BrokerClient | null = null;
let envWarned = false;

// Cache the life-context folder ID and its topic subfolder IDs across calls.
// Expires after FOLDER_CACHE_TTL_MS to pick up Drive folder changes without restart.
let lifeContextFolderId: string | null = null;
let topicFolderIds: Record<string, string> | null = null;
let folderCacheTime = 0;

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
  // Invalidate cache after TTL
  if (topicFolderIds && Date.now() - folderCacheTime > FOLDER_CACHE_TTL_MS) {
    lifeContextFolderId = null;
    topicFolderIds = null;
  }

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
  folderCacheTime = Date.now();

  return topicFolderIds[topic] ?? null;
}

/**
 * Load life-context files from Drive for the given agent.
 * Reads all .md files in the topic folder, sorted by modified date (newest first).
 * Applies a per-topic size budget, dropping oldest content first.
 *
 * @param agentName Agent preset name (e.g., 'life-work', 'life-travel')
 * @param sizeBudget Maximum bytes of content per topic (default: DEFAULT_TOPIC_SIZE_BUDGET)
 * @returns Formatted context string, or null if not a life-context agent or loading fails
 */
export async function loadLifeContext(
  agentName: string,
  sizeBudget: number = DEFAULT_TOPIC_SIZE_BUDGET,
): Promise<string | null> {
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

    // Filter to .md files only, sorted by modified_at descending (newest first)
    const mdFiles = listing.files
      .filter((f) => f.name.endsWith('.md'))
      .sort((a, b) => (b.modified_at ?? '').localeCompare(a.modified_at ?? ''));

    if (mdFiles.length === 0) {
      console.warn(`[life-context-loader] No .md files in ${topic} folder`);
      return null;
    }

    // Read files and apply size budget (newest first, drop oldest when over budget)
    const sections: string[] = [];
    let totalSize = 0;
    let filesIncluded = 0;

    for (const file of mdFiles) {
      const result = await client.driveRead(file.file_id);
      const section = `## ${file.name}\n${result.content}`;
      const sectionSize = new TextEncoder().encode(section).length;

      if (totalSize + sectionSize > sizeBudget && sections.length > 0) {
        // Budget exceeded — stop including more files
        const omitted = mdFiles.length - filesIncluded;
        if (omitted > 0) {
          sections.push(`[truncated: ${omitted} file${omitted > 1 ? 's' : ''} omitted due to size budget]`);
        }
        break;
      }

      sections.push(section);
      totalSize += sectionSize;
      filesIncluded++;
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
  folderCacheTime = 0;
}
