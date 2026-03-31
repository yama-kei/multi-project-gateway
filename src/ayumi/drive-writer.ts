import type { BrokerClient } from '../broker-client.js';
import type { FolderMap } from '../life-context-setup.js';
import type { TopicSummaryResult } from './topic-summarizer.js';

export interface DriveWriterOptions {
  approved?: boolean;
}

export interface DriveWriteResult {
  topic: string;
  written: boolean;
  filesWritten: string[];
  skippedReason?: string;
}

export async function writeTopicToDrive(
  client: BrokerClient,
  folderMap: FolderMap,
  summary: TopicSummaryResult,
  options?: DriveWriterOptions,
): Promise<DriveWriteResult> {
  const folderId = folderMap.topics[summary.topic];

  // Tier 3 requires explicit approval
  if (summary.requiresApproval && !options?.approved) {
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
