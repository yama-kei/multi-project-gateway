import type { BrokerClient } from '../broker-client.js';
import type { FolderMap } from './life-context-setup.js';
import type { TopicSummaryResult } from './topic-summarizer.js';
import type { TopicName } from './life-context-setup.js';

export interface DriveWriterOptions {
  approved?: boolean;
}

export interface DriveWriteResult {
  topic: string;
  written: boolean;
  filesWritten: string[];
  skippedReason?: string;
}

export interface PendingTopicEntry {
  fileCount: number;
  totalSize: number;
  preview: string;
  /** Full summary content, stored so approval can write without re-running the pipeline. */
  summaryContent: string;
}

export interface PendingReviewManifest {
  createdAt: string;
  topics: Record<string, PendingTopicEntry>;
}

const MANIFEST_NAME = 'pending-review.json';

export async function writeTopicToDrive(
  client: BrokerClient,
  folderMap: FolderMap,
  summary: TopicSummaryResult,
  options?: DriveWriterOptions,
): Promise<DriveWriteResult> {
  const folderId = folderMap.topics[summary.topic];

  // Tier 3 requires explicit approval — write manifest instead
  if (summary.requiresApproval && !options?.approved) {
    await addToPendingManifest(client, folderMap, summary);
    return {
      topic: summary.topic,
      written: false,
      filesWritten: [],
      skippedReason: 'approval_required',
    };
  }

  const filesWritten: string[] = [];

  // Write summary.md (always present)
  await client.driveWrite('summary.md', summary.files.summary, 'text', folderId);
  filesWritten.push('summary.md');

  // Write timeline.md (tier 1-2 only)
  if (summary.files.timeline) {
    await client.driveWrite('timeline.md', summary.files.timeline, 'text', folderId);
    filesWritten.push('timeline.md');
  }

  // Write entities.md (tier 1-2 only)
  if (summary.files.entities) {
    await client.driveWrite('entities.md', summary.files.entities, 'text', folderId);
    filesWritten.push('entities.md');
  }

  return {
    topic: summary.topic,
    written: true,
    filesWritten,
  };
}

/**
 * Read the pending-review manifest from the curator meta folder.
 * Returns null if no manifest exists.
 */
export async function readPendingManifest(
  client: BrokerClient,
  folderMap: FolderMap,
): Promise<PendingReviewManifest | null> {
  try {
    const listing = await client.driveList(folderMap.meta, MANIFEST_NAME);
    const file = listing.files.find((f) => f.name === MANIFEST_NAME);
    if (!file) return null;
    const content = await client.driveRead(file.file_id);
    return JSON.parse(content.content) as PendingReviewManifest;
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) the pending-review manifest to the curator meta folder.
 * If the manifest has no topics left, deletes it instead.
 */
export async function writePendingManifest(
  client: BrokerClient,
  folderMap: FolderMap,
  manifest: PendingReviewManifest | null,
): Promise<void> {
  if (!manifest || Object.keys(manifest.topics).length === 0) {
    // Write empty content to effectively clear; Drive doesn't have a delete via broker
    // but an empty manifest signals "nothing pending"
    await client.driveWrite(MANIFEST_NAME, '{}', 'text', folderMap.meta);
    return;
  }
  await client.driveWrite(MANIFEST_NAME, JSON.stringify(manifest, null, 2), 'text', folderMap.meta);
}

/**
 * Add a tier-3 topic summary to the pending-review manifest.
 */
async function addToPendingManifest(
  client: BrokerClient,
  folderMap: FolderMap,
  summary: TopicSummaryResult,
): Promise<void> {
  const existing = await readPendingManifest(client, folderMap);
  const manifest: PendingReviewManifest = existing ?? {
    createdAt: new Date().toISOString(),
    topics: {},
  };

  const fileCount = Object.values(summary.files).filter(Boolean).length;
  const totalSize = Object.values(summary.files)
    .filter((v): v is string => typeof v === 'string')
    .reduce((sum, content) => sum + content.length, 0);
  const preview = summary.files.summary.slice(0, 200);

  manifest.topics[summary.topic] = {
    fileCount,
    totalSize,
    preview,
    summaryContent: summary.files.summary,
  };
  await writePendingManifest(client, folderMap, manifest);
}

/**
 * Remove a topic from the pending manifest.
 * Returns true if the topic was found and removed.
 */
export async function removeFromManifest(
  client: BrokerClient,
  folderMap: FolderMap,
  topic: string,
): Promise<boolean> {
  const manifest = await readPendingManifest(client, folderMap);
  if (!manifest || !(topic in manifest.topics)) return false;
  delete manifest.topics[topic];
  await writePendingManifest(client, folderMap, manifest);
  return true;
}
