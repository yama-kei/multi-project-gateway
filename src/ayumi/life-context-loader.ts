/**
 * Loads life-context data for topic agents.
 *
 * Primary path: reads from local Obsidian vault via filesystem.
 * Fallback path: reads from Google Drive via broker (when VAULT_PATH is not set).
 *
 * Agent name → topic → vault path mapping:
 *   life-work    → vault/topics/work/
 *   life-travel  → vault/topics/travel/
 *   life-social  → vault/topics/social/
 *   life-hobbies → vault/topics/hobbies/
 *   life-finance → vault/topics/_sensitive/finance/
 *   life-health  → vault/topics/_sensitive/health/
 *
 * Files read: summary.md, timeline.md, entities.md (when they exist).
 * Missing files are skipped gracefully — a new or empty vault still works.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBrokerClient, type BrokerClient, type DriveFile } from '../broker-client.js';
import type { TopicName } from './life-context-setup.js';

const AGENT_TOPIC_MAP: Record<string, TopicName> = {
  'life-work': 'work',
  'life-travel': 'travel',
  'life-finance': 'finance',
  'life-health': 'health',
  'life-social': 'social',
  'life-hobbies': 'hobbies',
};

const SENSITIVE_TOPICS: TopicName[] = ['finance', 'health'];

/** Files to load from each topic folder, in order. */
const TOPIC_FILES = ['summary.md', 'timeline.md', 'entities.md'];

/** Maximum bytes of context content per topic before truncation. */
export const DEFAULT_TOPIC_SIZE_BUDGET = 8 * 1024; // 8 KB

/** Re-resolve folder IDs after this many milliseconds (5 minutes). */
const FOLDER_CACHE_TTL_MS = 5 * 60 * 1000;

// Module-level singleton broker client (for Drive fallback)
let brokerClient: BrokerClient | null = null;
let envWarned = false;

// Cache the life-context folder ID and its topic subfolder IDs across calls.
let lifeContextFolderId: string | null = null;
let topicFolderIds: Record<string, string> | null = null;
let folderCacheTime = 0;

/**
 * Resolve the vault directory path for a topic.
 */
function topicVaultPath(vaultPath: string, topic: TopicName): string {
  if (SENSITIVE_TOPICS.includes(topic)) {
    return join(vaultPath, 'topics', '_sensitive', topic);
  }
  return join(vaultPath, 'topics', topic);
}

/**
 * Load life-context from the local vault filesystem.
 * Reads summary.md, timeline.md, entities.md from the topic directory.
 * Missing files are skipped gracefully.
 */
async function loadFromVault(
  vaultPath: string,
  topic: TopicName,
  sizeBudget: number,
): Promise<string | null> {
  const dir = topicVaultPath(vaultPath, topic);
  const sections: string[] = [];
  let totalSize = 0;
  let filesIncluded = 0;

  for (const fileName of TOPIC_FILES) {
    try {
      const content = await readFile(join(dir, fileName), 'utf-8');
      // Strip frontmatter for context injection (agents don't need YAML metadata)
      const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
      const section = `## ${fileName}\n${stripped}`;
      const sectionSize = new TextEncoder().encode(section).length;

      if (totalSize + sectionSize > sizeBudget && sections.length > 0) {
        const remaining = TOPIC_FILES.length - filesIncluded;
        if (remaining > 0) {
          sections.push(`[truncated: ${remaining} file${remaining > 1 ? 's' : ''} omitted due to size budget]`);
        }
        break;
      }

      sections.push(section);
      totalSize += sectionSize;
      filesIncluded++;
    } catch {
      // File doesn't exist — skip gracefully
      continue;
    }
  }

  if (sections.length === 0) return null;

  return `--- LIFE CONTEXT DATA ---\n\n${sections.join('\n\n')}\n\n--- END LIFE CONTEXT DATA ---`;
}

/**
 * Load life-context for the given agent.
 *
 * If VAULT_PATH is set, reads from local vault filesystem (primary path).
 * Otherwise, falls back to Drive via broker (legacy path).
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

  // Primary path: local vault
  const vaultPath = process.env.VAULT_PATH;
  if (vaultPath) {
    try {
      return await loadFromVault(vaultPath, topic, sizeBudget);
    } catch (err) {
      console.error(`[life-context-loader] Error loading vault context for ${agentName}:`, err);
      return null;
    }
  }

  // Fallback: Drive via broker
  return loadFromDrive(agentName, topic, sizeBudget);
}

// ---- Drive fallback (legacy path) ----

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

async function resolveTopicFolderId(client: BrokerClient, topic: string): Promise<string | null> {
  if (topicFolderIds && Date.now() - folderCacheTime > FOLDER_CACHE_TTL_MS) {
    lifeContextFolderId = null;
    topicFolderIds = null;
  }

  if (topicFolderIds) {
    return topicFolderIds[topic] ?? null;
  }

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

async function loadFromDrive(
  agentName: string,
  topic: TopicName,
  sizeBudget: number,
): Promise<string | null> {
  const client = getOrCreateClient();
  if (!client) return null;

  try {
    const folderId = await resolveTopicFolderId(client, topic);
    if (!folderId) {
      console.error(`[life-context-loader] No folder found for topic "${topic}" in Drive`);
      return null;
    }

    const listing = await client.driveList(folderId);

    const mdFiles = listing.files
      .filter((f) => f.name.endsWith('.md'))
      .sort((a, b) => (b.modified_at ?? '').localeCompare(a.modified_at ?? ''));

    if (mdFiles.length === 0) {
      console.warn(`[life-context-loader] No .md files in ${topic} folder`);
      return null;
    }

    const sections: string[] = [];
    let totalSize = 0;
    let filesIncluded = 0;

    for (const file of mdFiles) {
      const result = await client.driveRead(file.file_id);
      const section = `## ${file.name}\n${result.content}`;
      const sectionSize = new TextEncoder().encode(section).length;

      if (totalSize + sectionSize > sizeBudget && sections.length > 0) {
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
