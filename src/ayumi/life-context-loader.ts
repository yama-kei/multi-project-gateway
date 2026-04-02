/**
 * Loads life-context data from Google Drive for topic agents.
 * Maps agent names (life-work, life-travel, etc.) to Drive topics
 * and assembles context from base files, delta files, and corrections.
 *
 * Assembly order:
 *   1. Base files (summary.md, timeline.md, entities.md)
 *   2. Delta files in chronological order (oldest → newest)
 *   3. Corrections applied inline against their referenced delta
 *
 * Budget enforcement prioritizes base files, then newest deltas.
 */

import { createBrokerClient, type BrokerClient, type DriveFile } from '../broker-client.js';
import type { TopicName } from './life-context-setup.js';

const AGENT_TOPIC_MAP: Record<string, TopicName> = {
  'life-work': 'work',
  'life-travel': 'travel',
  'life-social': 'social',
  'life-hobbies': 'hobbies',
};

/** Base files in their canonical display order. */
const BASE_FILE_ORDER = ['summary.md', 'timeline.md', 'entities.md'] as const;

/** Maximum bytes of context content per topic before truncation. */
export const DEFAULT_TOPIC_SIZE_BUDGET = 8 * 1024; // 8 KB

/** Re-resolve folder IDs after this many milliseconds (5 minutes). */
const FOLDER_CACHE_TTL_MS = 5 * 60 * 1000;

// Module-level singleton broker client
let brokerClient: BrokerClient | null = null;
let envWarned = false;

// Cache the life-context folder ID and its topic subfolder IDs across calls.
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

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

export interface FileFrontmatter {
  type?: 'delta' | 'correction';
  scan_range?: string;
  corrects?: string;
}

/**
 * Parse YAML frontmatter from a file's content.
 * Returns the parsed fields and the body (content after frontmatter).
 */
export function parseFrontmatter(content: string): { meta: FileFrontmatter; body: string } {
  if (!content.startsWith('---\n')) {
    return { meta: {}, body: content };
  }

  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    return { meta: {}, body: content };
  }

  const yamlBlock = content.slice(4, endIdx);
  const meta: FileFrontmatter = {};

  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'type' && (value === 'delta' || value === 'correction')) {
      meta.type = value;
    } else if (key === 'scan_range') {
      meta.scan_range = value;
    } else if (key === 'corrects') {
      meta.corrects = value;
    }
  }

  const body = content.slice(endIdx + 5); // skip past "\n---\n"
  return { meta, body };
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

type FileKind = 'base' | 'delta' | 'correction';

interface ClassifiedFile {
  driveFile: DriveFile;
  kind: FileKind;
  /** For deltas: the date from the filename (YYYY-MM-DD). */
  deltaDate?: string;
  /** Parsed frontmatter (populated after content is read). */
  meta?: FileFrontmatter;
  /** Content body (after frontmatter stripped). */
  body?: string;
  /** Full raw content. */
  rawContent?: string;
}

const BASE_FILE_NAMES = new Set(BASE_FILE_ORDER);
const DELTA_PATTERN = /^delta-(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Classify a Drive file by its name.
 * Files without frontmatter are classified by name only;
 * actual content-based classification happens after reading.
 */
function classifyByName(file: DriveFile): ClassifiedFile {
  if (BASE_FILE_NAMES.has(file.name)) {
    return { driveFile: file, kind: 'base' };
  }

  const deltaMatch = file.name.match(DELTA_PATTERN);
  if (deltaMatch) {
    return { driveFile: file, kind: 'delta', deltaDate: deltaMatch[1] };
  }

  // Unknown .md files default to base
  return { driveFile: file, kind: 'base' };
}

/**
 * After reading content, refine classification using frontmatter.
 */
function refineWithContent(cf: ClassifiedFile, content: string): void {
  cf.rawContent = content;
  const { meta, body } = parseFrontmatter(content);
  cf.meta = meta;
  cf.body = body;

  if (meta.type === 'correction') {
    cf.kind = 'correction';
  } else if (meta.type === 'delta' && cf.kind !== 'delta') {
    cf.kind = 'delta';
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface AssembledSection {
  name: string;
  content: string;
  size: number;
}

/**
 * Assemble context sections from classified files.
 *
 * Order: base files first (summary → timeline → entities),
 * then deltas in chronological order (oldest → newest).
 * Corrections replace their referenced delta's content inline.
 */
function assembleContext(
  files: ClassifiedFile[],
  sizeBudget: number,
): { sections: AssembledSection[]; truncatedCount: number; truncatedRange?: string } {
  // Separate by kind
  const baseFiles: ClassifiedFile[] = [];
  const deltaFiles: ClassifiedFile[] = [];
  const corrections = new Map<string, ClassifiedFile>(); // corrects filename → correction file

  for (const f of files) {
    if (f.kind === 'correction' && f.meta?.corrects) {
      corrections.set(f.meta.corrects, f);
    } else if (f.kind === 'delta') {
      deltaFiles.push(f);
    } else {
      baseFiles.push(f);
    }
  }

  // Sort base files in canonical order
  baseFiles.sort((a, b) => {
    const ai = BASE_FILE_ORDER.indexOf(a.driveFile.name as typeof BASE_FILE_ORDER[number]);
    const bi = BASE_FILE_ORDER.indexOf(b.driveFile.name as typeof BASE_FILE_ORDER[number]);
    // Known base files get their canonical index; unknown files go after
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  // Sort deltas chronologically (oldest first for assembly narrative)
  deltaFiles.sort((a, b) => (a.deltaDate ?? '').localeCompare(b.deltaDate ?? ''));

  // Apply corrections to deltas
  for (const delta of deltaFiles) {
    const correction = corrections.get(delta.driveFile.name);
    if (correction) {
      delta.body = correction.body ?? delta.body;
      corrections.delete(delta.driveFile.name);
    }
  }

  // Phase 1: Always include base files (at minimum summary.md)
  const sections: AssembledSection[] = [];
  let totalSize = 0;

  for (const f of baseFiles) {
    const displayContent = f.body ?? f.rawContent ?? '';
    const section: AssembledSection = {
      name: f.driveFile.name,
      content: `## ${f.driveFile.name}\n${displayContent}`,
      size: 0,
    };
    section.size = new TextEncoder().encode(section.content).length;
    sections.push(section);
    totalSize += section.size;
  }

  // Phase 2: Fill remaining budget with deltas, newest first
  // (most recent deltas are most valuable — budget drops oldest first)
  const remainingBudget = sizeBudget - totalSize;

  if (remainingBudget > 0 && deltaFiles.length > 0) {
    // Try to fit deltas; newest first for budget selection
    const deltaSections: AssembledSection[] = [];
    for (const f of deltaFiles) {
      const displayContent = f.body ?? f.rawContent ?? '';
      const section: AssembledSection = {
        name: f.driveFile.name,
        content: `## ${f.driveFile.name}\n${displayContent}`,
        size: 0,
      };
      section.size = new TextEncoder().encode(section.content).length;
      deltaSections.push(section);
    }

    // Select from newest to oldest to fill budget
    let deltaSize = deltaSections.reduce((sum, s) => sum + s.size, 0);
    let dropFromStart = 0; // oldest deltas are at start (sorted chronologically)

    while (deltaSize > remainingBudget && dropFromStart < deltaSections.length) {
      deltaSize -= deltaSections[dropFromStart].size;
      dropFromStart++;
    }

    const includedDeltas = deltaSections.slice(dropFromStart);
    const truncatedCount = dropFromStart;

    // Assemble in chronological order (the included slice is already chronological)
    for (const s of includedDeltas) {
      sections.push(s);
    }

    // Build truncation range from dropped deltas
    let truncatedRange: string | undefined;
    if (truncatedCount > 0) {
      const droppedDates = deltaFiles.slice(0, truncatedCount).map((f) => f.deltaDate).filter(Boolean);
      if (droppedDates.length > 0) {
        truncatedRange = `${droppedDates[0]} to ${droppedDates[droppedDates.length - 1]}`;
      }
    }

    // Include orphan corrections (whose referenced delta doesn't exist)
    for (const [, correction] of corrections) {
      const displayContent = correction.body ?? correction.rawContent ?? '';
      const section: AssembledSection = {
        name: correction.driveFile.name,
        content: `## ${correction.driveFile.name}\n${displayContent}`,
        size: 0,
      };
      section.size = new TextEncoder().encode(section.content).length;
      if (totalSize + deltaSize + section.size <= sizeBudget) {
        sections.push(section);
      }
    }

    return { sections, truncatedCount, truncatedRange };
  }

  // No deltas or no budget remaining
  // Include orphan corrections as standalone entries
  for (const [, correction] of corrections) {
    const displayContent = correction.body ?? correction.rawContent ?? '';
    const section: AssembledSection = {
      name: correction.driveFile.name,
      content: `## ${correction.driveFile.name}\n${displayContent}`,
      size: 0,
    };
    section.size = new TextEncoder().encode(section.content).length;
    sections.push(section);
  }

  return { sections, truncatedCount: 0 };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Load life-context files from Drive for the given agent.
 * Assembles base files + deltas + corrections with a size budget.
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

    // Filter to .md files
    const mdFiles = listing.files.filter((f) => f.name.endsWith('.md'));
    if (mdFiles.length === 0) {
      console.warn(`[life-context-loader] No .md files in ${topic} folder`);
      return null;
    }

    // Classify files by name
    const classified = mdFiles.map(classifyByName);

    // Read all file contents and refine classification
    for (const cf of classified) {
      const result = await client.driveRead(cf.driveFile.file_id);
      refineWithContent(cf, result.content);
    }

    // Assemble with budget
    const { sections, truncatedCount, truncatedRange } = assembleContext(classified, sizeBudget);

    if (sections.length === 0) return null;

    const parts = sections.map((s) => s.content);
    if (truncatedCount > 0) {
      const rangeStr = truncatedRange ? `, covering ${truncatedRange}` : '';
      parts.push(`[truncated: ${truncatedCount} delta${truncatedCount > 1 ? 's' : ''} omitted${rangeStr}]`);
    }

    return `--- LIFE CONTEXT DATA ---\n\n${parts.join('\n\n')}\n\n--- END LIFE CONTEXT DATA ---`;
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
