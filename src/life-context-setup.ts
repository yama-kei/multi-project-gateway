/**
 * Idempotent setup for the /life-context/ folder tree in Google Drive.
 * Searches for an existing folder-map.json first; creates any missing folders.
 */

import type { BrokerClient } from './broker-client.js';

export const TOPIC_FOLDERS = ['work', 'travel', 'finance', 'health', 'social', 'hobbies'] as const;
export type TopicName = (typeof TOPIC_FOLDERS)[number];

export interface FolderMap {
  root: string;
  topics: Record<TopicName, string>;
  meta: string;
}

const FOLDER_MAP_NAME = 'folder-map.json';

/**
 * Ensure the life-context folder tree exists in Drive.
 * Returns a FolderMap with all folder IDs.
 *
 * Idempotent: reads existing folder-map.json from Drive if present,
 * creates only missing folders, and writes the updated map back.
 */
export async function ensureLifeContextFolders(client: BrokerClient): Promise<FolderMap> {
  // Step 1: Check for existing folder-map.json
  const existing = await loadExistingMap(client);
  if (existing && isComplete(existing)) {
    return existing;
  }

  // Step 2: Start from existing partial map or build from scratch
  const map: FolderMap = existing ?? {
    root: '',
    topics: { work: '', travel: '', finance: '', health: '', social: '', hobbies: '' },
    meta: '',
  };

  // Step 3: Create root folder if missing
  if (!map.root) {
    const result = await client.driveCreateFolder('life-context', undefined);
    map.root = result.folder_id;
  }

  // Step 4: Create topic folders if missing
  for (const topic of TOPIC_FOLDERS) {
    if (!map.topics[topic]) {
      const result = await client.driveCreateFolder(topic, map.root);
      map.topics[topic] = result.folder_id;
    }
  }

  // Step 5: Create _meta folder if missing
  if (!map.meta) {
    const result = await client.driveCreateFolder('_meta', map.root);
    map.meta = result.folder_id;
  }

  // Step 6: Write folder-map.json to _meta
  await client.driveWrite(FOLDER_MAP_NAME, JSON.stringify(map, null, 2), 'text');

  return map;
}

async function loadExistingMap(client: BrokerClient): Promise<FolderMap | null> {
  try {
    const searchResult = await client.driveSearch(FOLDER_MAP_NAME);
    const mapFile = searchResult.files.find((f) => f.name === FOLDER_MAP_NAME);
    if (!mapFile) return null;

    const content = await client.driveRead(mapFile.file_id);
    return JSON.parse(content.content) as FolderMap;
  } catch {
    return null;
  }
}

function isComplete(map: FolderMap): boolean {
  if (!map.root || !map.meta) return false;
  return TOPIC_FOLDERS.every((t) => !!map.topics[t]);
}
