/**
 * Discord commands for the life-context curator.
 *
 * Commands:
 *   !curator pending              — list pending tier-3 topics
 *   !curator approve <topic|all>  — approve and write to Drive
 *   !curator reject <topic>       — remove from manifest without writing
 *   !curator sync                 — incremental scan since last checkpoint
 *   !curator seed <start> <end>   — full seed run for a date range
 *   !curator status               — show scan state summary
 */

import type { BrokerClient } from '../broker-client.js';
import { createBrokerClientFromEnv } from '../broker-client.js';
import { ensureLifeContextFolders, TOPIC_FOLDERS, type FolderMap, type TopicName } from './life-context-setup.js';
import {
  readPendingManifest,
  removeFromManifest,
  writePendingManifest,
  writeTopicToDrive,
  writeDeltaToDrive,
} from './drive-writer.js';
import { extractAndClassify, type ClassifiedItem } from './extraction-pipeline.js';
import { summarizeTopic } from './topic-summarizer.js';
import { loadExclusions } from './exclusions.js';
import {
  readScanState,
  writeScanState,
  updateTopicScanState,
  type ScanState,
} from './scan-state.js';

/**
 * Handle a `!curator <subcommand>` message.
 * Returns a formatted Discord response string, or null if the command is not recognized.
 */
export async function handleCuratorCommand(text: string): Promise<string | null> {
  const match = text.match(/^!curator\s+(\S+)(?:\s+(.*))?$/i);
  if (!match) return null;

  const subcommand = match[1].toLowerCase();
  const arg = match[2]?.trim() ?? '';

  let client: BrokerClient;
  let folderMap: FolderMap;
  try {
    client = createBrokerClientFromEnv();
    folderMap = await ensureLifeContextFolders(client);
  } catch (err) {
    return `Failed to connect to Drive: ${err instanceof Error ? err.message : String(err)}`;
  }

  switch (subcommand) {
    case 'pending':
      return handlePending(client, folderMap);
    case 'approve':
      if (!arg) return 'Usage: `!curator approve <topic>` or `!curator approve all`';
      return handleApprove(client, folderMap, arg);
    case 'reject':
      if (!arg) return 'Usage: `!curator reject <topic>`';
      return handleReject(client, folderMap, arg);
    case 'sync':
      return handleSync(client, folderMap);
    case 'seed':
      if (!arg) return 'Usage: `!curator seed <start-date> <end-date>` (e.g., `!curator seed 2026-03-01 2026-04-01`)';
      return handleSeed(client, folderMap, arg);
    case 'status':
      return handleStatus(client, folderMap);
    default:
      return [
        `Unknown curator command: \`${subcommand}\``,
        'Available: `!curator pending`, `!curator approve <topic|all>`, `!curator reject <topic>`, `!curator sync`, `!curator seed <range>`, `!curator status`',
      ].join('\n');
  }
}

// ---------------------------------------------------------------------------
// Approval commands (from PR #184)
// ---------------------------------------------------------------------------

async function handlePending(
  client: BrokerClient,
  folderMap: FolderMap,
): Promise<string> {
  const manifest = await readPendingManifest(client, folderMap);
  if (!manifest || Object.keys(manifest.topics).length === 0) {
    return 'No pending tier-3 topics awaiting review.';
  }

  const lines = ['**Pending tier-3 topics for review:**', ''];
  for (const [topic, entry] of Object.entries(manifest.topics)) {
    lines.push(`**${topic}** — ${entry.fileCount} file(s), ${entry.totalSize} bytes`);
    lines.push(`> ${entry.preview.slice(0, 200)}${entry.preview.length > 200 ? '...' : ''}`);
    lines.push('');
  }
  lines.push(`Created: ${manifest.createdAt}`);
  lines.push('');
  lines.push('Use `!curator approve <topic>` or `!curator approve all` to write to Drive.');
  lines.push('Use `!curator reject <topic>` to discard.');

  return lines.join('\n');
}

async function handleApprove(
  client: BrokerClient,
  folderMap: FolderMap,
  arg: string,
): Promise<string> {
  const manifest = await readPendingManifest(client, folderMap);
  if (!manifest || Object.keys(manifest.topics).length === 0) {
    return 'No pending topics to approve.';
  }

  const topicsToApprove = arg.toLowerCase() === 'all'
    ? Object.keys(manifest.topics)
    : [arg.toLowerCase()];

  const results: string[] = [];

  for (const topic of topicsToApprove) {
    if (!(topic in manifest.topics)) {
      results.push(`**${topic}** — not found in pending manifest, skipped.`);
      continue;
    }

    const folderId = folderMap.topics[topic as TopicName];
    if (!folderId) {
      results.push(`**${topic}** — no Drive folder found, skipped.`);
      continue;
    }

    const entry = manifest.topics[topic];

    // Write the full content (stored in manifest at approval-skip time)
    // Detect delta vs base file by checking if content has delta frontmatter
    const fileName = entry.summaryContent.startsWith('---\ntype: delta')
      ? `delta-${extractDeltaDate(entry.summaryContent)}.md`
      : 'summary.md';
    await client.driveWrite(fileName, entry.summaryContent, 'text', folderId);
    delete manifest.topics[topic];
    results.push(`**${topic}** — approved and written to Drive.`);
  }

  // Update or clear manifest
  await writePendingManifest(client, folderMap, manifest);

  return results.join('\n');
}

/** Extract the end date from delta frontmatter for file naming. */
function extractDeltaDate(content: string): string {
  const match = content.match(/scan_range:\s*\S+\s+to\s+(\S+)/);
  return match?.[1] ?? new Date().toISOString().split('T')[0];
}

async function handleReject(
  client: BrokerClient,
  folderMap: FolderMap,
  arg: string,
): Promise<string> {
  const topic = arg.toLowerCase();
  const removed = await removeFromManifest(client, folderMap, topic);
  if (!removed) {
    return `Topic \`${topic}\` not found in pending manifest.`;
  }
  return `**${topic}** — rejected and removed from pending review.`;
}

// ---------------------------------------------------------------------------
// Sync / Seed / Status commands
// ---------------------------------------------------------------------------

const TOPIC_TIER_MAP: Record<TopicName, 1 | 2 | 3> = {
  work: 2,
  travel: 1,
  finance: 3,
  health: 3,
  social: 2,
  hobbies: 1,
};

async function handleSync(
  client: BrokerClient,
  folderMap: FolderMap,
): Promise<string> {
  const scanState = await readScanState(client, folderMap.meta);

  if (!scanState.last_seed) {
    return 'No seed run found. Run `!curator seed <start-date> <end-date>` first.';
  }

  const exclusions = loadExclusions();
  const today = new Date().toISOString().split('T')[0];
  const results: string[] = ['**Sync results:**', ''];

  let updatedState = scanState;

  for (const topic of TOPIC_FOLDERS) {
    const topicState = scanState.topics[topic];
    const timeMin = topicState?.gmail_after
      ? `${topicState.gmail_after}T00:00:00Z`
      : scanState.last_seed;
    const timeMax = `${today}T23:59:59Z`;

    // Extract items for this scan window
    const allItems = await extractAndClassify(client, exclusions, { timeMin, timeMax });
    const topicItems = allItems.filter((item) => item.topic === topic);

    if (topicItems.length === 0) {
      results.push(`**${topic}** — no new items`);
      continue;
    }

    // Generate delta content
    const sourceCounts = countSources(topicItems);
    const deltaBody = generateDeltaBody(topic, topicItems);
    const tier = TOPIC_TIER_MAP[topic];

    const writeResult = await writeDeltaToDrive(client, folderMap, {
      topic,
      content: deltaBody,
      requiresApproval: tier === 3,
    }, {
      scanRange: { start: topicState?.gmail_after ?? today, end: today },
      sourceCounts,
    });

    // Update scan state watermarks
    updatedState = updateTopicScanState(updatedState, topic, {
      topic,
      scanEndDate: today,
      itemCount: topicItems.length,
    });

    if (writeResult.written) {
      results.push(`**${topic}** — ${topicItems.length} item(s), wrote ${writeResult.filesWritten.join(', ')}`);
    } else {
      results.push(`**${topic}** — ${topicItems.length} item(s), pending approval`);
    }
  }

  await writeScanState(client, folderMap.meta, updatedState);
  results.push('', 'Scan state updated.');

  return results.join('\n');
}

async function handleSeed(
  client: BrokerClient,
  folderMap: FolderMap,
  arg: string,
): Promise<string> {
  const parts = arg.split(/\s+/);
  if (parts.length < 2) {
    return 'Usage: `!curator seed <start-date> <end-date>` (e.g., `!curator seed 2026-03-01 2026-04-01`)';
  }
  const [startDate, endDate] = parts;

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return 'Invalid date format. Use YYYY-MM-DD (e.g., `!curator seed 2026-03-01 2026-04-01`).';
  }

  const exclusions = loadExclusions();
  const timeMin = `${startDate}T00:00:00Z`;
  const timeMax = `${endDate}T23:59:59Z`;

  const allItems = await extractAndClassify(client, exclusions, { timeMin, timeMax });

  // Group items by topic
  const byTopic = new Map<TopicName, ClassifiedItem[]>();
  for (const item of allItems) {
    const existing = byTopic.get(item.topic) ?? [];
    existing.push(item);
    byTopic.set(item.topic, existing);
  }

  const results: string[] = [`**Seed run: ${startDate} to ${endDate}**`, ''];
  results.push(`Total items extracted: ${allItems.length}`);
  results.push('');

  // Write base files per topic
  for (const topic of TOPIC_FOLDERS) {
    const items = byTopic.get(topic) ?? [];
    if (items.length === 0) {
      results.push(`**${topic}** — 0 items, skipped`);
      continue;
    }

    const summary = summarizeTopic(topic, items);
    const writeResult = await writeTopicToDrive(client, folderMap, summary);

    if (writeResult.written) {
      results.push(`**${topic}** — ${items.length} item(s), wrote ${writeResult.filesWritten.join(', ')}`);
    } else {
      results.push(`**${topic}** — ${items.length} item(s), pending approval`);
    }
  }

  // Initialize scan state
  const now = new Date().toISOString();
  const compactionDate = new Date();
  compactionDate.setMonth(compactionDate.getMonth() + 1);

  const scanState: ScanState = {
    last_seed: now,
    topics: {},
    next_compaction: compactionDate.toISOString().split('T')[0],
  };

  for (const topic of TOPIC_FOLDERS) {
    scanState.topics[topic] = {
      last_scan: now,
      gmail_after: endDate,
      pending_deltas: 0,
    };
  }

  await writeScanState(client, folderMap.meta, scanState);
  results.push('', 'Scan state initialized.');

  return results.join('\n');
}

async function handleStatus(
  client: BrokerClient,
  folderMap: FolderMap,
): Promise<string> {
  const state = await readScanState(client, folderMap.meta);

  if (!state.last_seed) {
    return 'No scan state found. Run `!curator seed <start-date> <end-date>` to initialize.';
  }

  const lines = ['**Curator scan status:**', ''];
  lines.push(`Last seed: ${state.last_seed}`);
  lines.push(`Next compaction: ${state.next_compaction || 'not set'}`);
  lines.push('');
  lines.push('**Per-topic status:**');

  for (const topic of TOPIC_FOLDERS) {
    const ts = state.topics[topic];
    if (!ts) {
      lines.push(`- **${topic}** — no scan data`);
      continue;
    }
    lines.push(`- **${topic}** — last scan: ${ts.last_scan.split('T')[0]}, watermark: ${ts.gmail_after}, pending deltas: ${ts.pending_deltas}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countSources(items: ClassifiedItem[]): { gmail: number; calendar: number } {
  const counts = { gmail: 0, calendar: 0 };
  for (const item of items) counts[item.source]++;
  return counts;
}

function generateDeltaBody(topic: string, items: ClassifiedItem[]): string {
  const title = topic.charAt(0).toUpperCase() + topic.slice(1);
  const lines: string[] = [];

  lines.push(`## New ${title} activity`);
  lines.push('');
  for (const item of items.slice(0, 20)) {
    const date = item.date.split('T')[0];
    const source = item.source === 'gmail' ? '📧' : '📅';
    lines.push(`- ${date} ${source} **${item.subject}** — ${item.snippet.slice(0, 100)}`);
  }
  if (items.length > 20) {
    lines.push(`- ... and ${items.length - 20} more items`);
  }
  lines.push('');

  // Entity updates section
  const people = new Map<string, number>();
  for (const item of items) {
    if (item.from) {
      people.set(item.from, (people.get(item.from) ?? 0) + 1);
    }
  }
  if (people.size > 0) {
    lines.push('## Entity updates');
    lines.push('');
    const sorted = [...people.entries()].sort((a, b) => b[1] - a[1]);
    for (const [email, count] of sorted.slice(0, 10)) {
      lines.push(`- ${email} (${count} interaction${count > 1 ? 's' : ''})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
