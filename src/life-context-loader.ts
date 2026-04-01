/**
 * Pre-fetches life-context data from Google Drive and returns a formatted
 * string to inject into a topic agent's system prompt.
 */

import { createBrokerClientFromEnv, type BrokerClient } from './broker-client.js';

const TOPIC_MAP: Record<string, string> = {
  'life-work': 'work',
  'life-travel': 'travel',
  'life-social': 'social',
  'life-hobbies': 'hobbies',
};

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 32 * 1024; // 32 KB
const TIMEOUT_MS = 5_000;

let cachedClient: BrokerClient | null = null;
let brokerUnavailable = false;

function getClient(): BrokerClient | null {
  if (brokerUnavailable) return null;
  if (cachedClient) return cachedClient;
  try {
    cachedClient = createBrokerClientFromEnv();
    return cachedClient;
  } catch {
    console.warn('[life-context] Broker env vars not configured — life-context injection disabled');
    brokerUnavailable = true;
    return null;
  }
}

export async function loadLifeContext(agentName: string): Promise<string | null> {
  const topic = TOPIC_MAP[agentName];
  if (!topic) return null;

  const client = getClient();
  if (!client) return null;

  try {
    return await withTimeout(fetchContext(client, topic, agentName), TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[life-context] Failed to load context for ${agentName}: ${msg}`);
    return null;
  }
}

async function fetchContext(client: BrokerClient, topic: string, agentName: string): Promise<string | null> {
  // Step 1: Find folder-map.json
  const searchResult = await client.driveSearch('folder-map.json');
  const mapFile = searchResult.files.find((f) => f.name === 'folder-map.json');
  if (!mapFile) return null;

  // Step 2: Read folder map to get topic folder ID
  const mapContent = await client.driveRead(mapFile.file_id);
  const folderMap = JSON.parse(mapContent.content) as { topics: Record<string, string> };
  const folderId = folderMap.topics[topic];
  if (!folderId) return null;

  // Step 3: List files in topic folder
  const listing = await client.driveList(folderId);
  if (listing.files.length === 0) return null;

  // Step 4: Read files with size/count guards
  const filesToRead = listing.files.slice(0, MAX_FILES);
  const sections: string[] = [];
  let totalBytes = 0;

  for (const file of filesToRead) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      console.warn(`[life-context] ${agentName}: aggregate size limit reached (${MAX_TOTAL_BYTES} bytes), skipping remaining files`);
      break;
    }
    const content = await client.driveRead(file.file_id);
    const text = content.content;
    if (totalBytes + text.length > MAX_TOTAL_BYTES) {
      console.warn(`[life-context] ${agentName}: skipping ${file.name} (would exceed ${MAX_TOTAL_BYTES} byte limit)`);
      continue;
    }
    totalBytes += text.length;
    sections.push(`## ${file.name}\n${text}`);
  }

  if (sections.length === 0) return null;

  const sizeKB = (totalBytes / 1024).toFixed(1);
  console.log(`[life-context] Injected ${sections.length} files / ${sizeKB}KB for ${agentName}`);

  return `\n\n--- LIFE CONTEXT DATA ---\n\n${sections.join('\n\n')}\n\n--- END LIFE CONTEXT DATA ---`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Exported for testing — resets the cached broker client. */
export function _resetForTesting(): void {
  cachedClient = null;
  brokerUnavailable = false;
}
