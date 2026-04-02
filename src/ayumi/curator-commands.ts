/**
 * Discord commands for managing tier-3 content approval.
 *
 * Commands:
 *   !curator pending              — list pending tier-3 topics
 *   !curator approve <topic|all>  — approve and write to Drive
 *   !curator reject <topic>       — remove from manifest without writing
 */

import type { BrokerClient } from '../broker-client.js';
import { createBrokerClientFromEnv } from '../broker-client.js';
import { ensureLifeContextFolders, type FolderMap, type TopicName } from './life-context-setup.js';
import {
  readPendingManifest,
  removeFromManifest,
  writePendingManifest,
} from './drive-writer.js';

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
    default:
      return [
        `Unknown curator command: \`${subcommand}\``,
        'Available: `!curator pending`, `!curator approve <topic|all>`, `!curator reject <topic>`',
      ].join('\n');
  }
}

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

    // Write the full summary.md (stored in manifest at approval-skip time)
    await client.driveWrite('summary.md', entry.summaryContent, 'text', folderId);
    delete manifest.topics[topic];
    results.push(`**${topic}** — approved and written to Drive.`);
  }

  // Update or clear manifest
  await writePendingManifest(client, folderMap, manifest);

  return results.join('\n');
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
