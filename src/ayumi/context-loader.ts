/**
 * Loads life-context files from Google Drive and formats them
 * for injection into agent system prompts.
 */

import type { BrokerClient, DriveFile } from '../broker-client.js';
import type { FolderMap } from '../life-context-setup.js';

/** ~50K tokens ≈ 200K characters */
const MAX_CONTEXT_CHARS = 200_000;

const FOLDER_MAP_NAME = 'folder-map.json';

export interface LoadedContext {
  content: string;
  /** Paths that were loaded successfully */
  loaded: string[];
  /** Paths that were not found or failed */
  missing: string[];
  /** Whether any content was truncated to fit the token budget */
  truncated: boolean;
}

/**
 * Parse a logical path like `/life-context/work/summary.md`
 * into { topic: 'work', filename: 'summary.md' }.
 */
export function parseContextPath(path: string): { topic: string; filename: string } | null {
  const match = path.match(/^\/life-context\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { topic: match[1], filename: match[2] };
}

/**
 * Load the folder-map.json from Drive's _meta folder.
 */
async function loadFolderMap(client: BrokerClient): Promise<FolderMap | null> {
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

/**
 * Find a file by name within a folder's file listing.
 */
function findFile(files: DriveFile[], filename: string): DriveFile | undefined {
  return files.find((f) => f.name === filename);
}

/**
 * Load Drive context files and format them for system prompt injection.
 *
 * @param contextPaths Logical paths like `/life-context/work/summary.md`
 * @param client Broker client for Drive API calls
 * @returns Formatted context string with section headers
 */
export async function loadDriveContext(
  contextPaths: string[],
  client: BrokerClient,
): Promise<LoadedContext> {
  if (contextPaths.length === 0) {
    return { content: '', loaded: [], missing: [], truncated: false };
  }

  // Parse all paths and group by topic
  const parsed = contextPaths.map((p) => ({ path: p, ...parseContextPath(p) }));
  const topics = new Set(parsed.filter((p) => p.topic).map((p) => p.topic!));

  // Load folder map to resolve topic → folder ID
  const folderMap = await loadFolderMap(client);
  if (!folderMap) {
    return {
      content: '<!-- Drive folder map not found — context unavailable -->\n',
      loaded: [],
      missing: [...contextPaths],
      truncated: false,
    };
  }

  // List files in each relevant topic folder
  const folderListings = new Map<string, DriveFile[]>();
  for (const topic of topics) {
    const folderId = folderMap.topics[topic as keyof typeof folderMap.topics];
    if (!folderId) continue;
    try {
      const listing = await client.driveList(folderId);
      folderListings.set(topic, listing.files);
    } catch {
      // Folder inaccessible — files in this topic will be reported as missing
    }
  }

  // Fetch each file
  const loaded: string[] = [];
  const missing: string[] = [];
  const sections: Array<{ path: string; filename: string; content: string; priority: number }> = [];

  for (const entry of parsed) {
    if (!entry.topic || !entry.filename) {
      missing.push(entry.path);
      continue;
    }

    const files = folderListings.get(entry.topic);
    if (!files) {
      missing.push(entry.path);
      continue;
    }

    const file = findFile(files, entry.filename);
    if (!file) {
      missing.push(entry.path);
      continue;
    }

    try {
      const result = await client.driveRead(file.file_id);
      // summary.md gets highest priority (kept in full during truncation)
      const priority = entry.filename === 'summary.md' ? 0 : 1;
      sections.push({ path: entry.path, filename: entry.filename, content: result.content, priority });
      loaded.push(entry.path);
    } catch {
      missing.push(entry.path);
    }
  }

  // Sort: summary.md first (priority 0), then others
  sections.sort((a, b) => a.priority - b.priority);

  // Apply token budget
  let truncated = false;
  const formatted: string[] = ['## Loaded Life Context\n'];
  let totalChars = formatted[0].length;

  for (const section of sections) {
    const header = `### ${section.filename}\n`;
    const body = section.content;
    const sectionLen = header.length + body.length + 2; // +2 for trailing newlines

    if (totalChars + sectionLen <= MAX_CONTEXT_CHARS) {
      formatted.push(header + body + '\n');
      totalChars += sectionLen;
    } else if (section.priority === 0) {
      // summary.md — always include in full
      formatted.push(header + body + '\n');
      totalChars += sectionLen;
    } else {
      // Truncate lower-priority files to fit
      const remaining = MAX_CONTEXT_CHARS - totalChars - header.length - 50; // 50 for truncation notice
      if (remaining > 0) {
        formatted.push(header + body.slice(0, remaining) + '\n\n<!-- truncated to fit token budget -->\n');
      } else {
        formatted.push(header + '<!-- omitted to fit token budget -->\n');
      }
      truncated = true;
    }
  }

  // Note missing files
  for (const path of missing) {
    formatted.push(`<!-- ${path.split('/').pop()} not found -->`);
  }

  return {
    content: formatted.join('\n'),
    loaded,
    missing,
    truncated,
  };
}
