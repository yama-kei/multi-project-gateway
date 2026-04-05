/**
 * Discord commands for managing tier-3 content approval.
 *
 * Commands:
 *   !curator pending              — list pending tier-3 topics
 *   !curator approve <topic|all>  — approve and write to vault
 *   !curator reject <topic>       — remove from manifest without writing
 *
 * Primary path: reads/writes pending-review.json from $VAULT_PATH/_meta/.
 * Fallback: uses Drive via broker when VAULT_PATH is not set.
 */

import type { BrokerClient } from '../broker-client.js';
import { createBrokerClientFromEnv } from '../broker-client.js';
import { ensureLifeContextFolders, type FolderMap, type TopicName } from './life-context-setup.js';
import {
  readPendingManifest as readDriveManifest,
  removeFromManifest as removeFromDriveManifest,
  writePendingManifest as writeDriveManifest,
} from './drive-writer.js';
import {
  readVaultPendingManifest,
  writeVaultPendingManifest,
  removeFromVaultManifest,
  writeTopicToVault,
  generateFrontmatter,
  topicDir,
  type PendingReviewManifest,
} from './vault-writer.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Handle a `!curator <subcommand>` message.
 * Returns a formatted Discord response string, or null if the command is not recognized.
 */
export async function handleCuratorCommand(text: string): Promise<string | null> {
  const match = text.match(/^!curator\s+(\S+)(?:\s+(.*))?$/i);
  if (!match) return null;

  const subcommand = match[1].toLowerCase();
  const arg = match[2]?.trim() ?? '';

  const vaultPath = process.env.VAULT_PATH;

  if (vaultPath) {
    return handleVaultCommand(subcommand, arg, vaultPath);
  }

  // Fallback: Drive via broker
  return handleDriveCommand(subcommand, arg);
}

// ---- Vault path (primary) ----

async function handleVaultCommand(
  subcommand: string,
  arg: string,
  vaultPath: string,
): Promise<string> {
  switch (subcommand) {
    case 'pending':
      return handleVaultPending(vaultPath);
    case 'approve':
      if (!arg) return 'Usage: `!curator approve <topic>` or `!curator approve all`';
      return handleVaultApprove(vaultPath, arg);
    case 'reject':
      if (!arg) return 'Usage: `!curator reject <topic>`';
      return handleVaultReject(vaultPath, arg);
    default:
      return [
        `Unknown curator command: \`${subcommand}\``,
        'Available: `!curator pending`, `!curator approve <topic|all>`, `!curator reject <topic>`',
      ].join('\n');
  }
}

async function handleVaultPending(vaultPath: string): Promise<string> {
  const manifest = await readVaultPendingManifest(vaultPath);
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
  lines.push('Use `!curator approve <topic>` or `!curator approve all` to write to vault.');
  lines.push('Use `!curator reject <topic>` to discard.');

  return lines.join('\n');
}

async function handleVaultApprove(vaultPath: string, arg: string): Promise<string> {
  const manifest = await readVaultPendingManifest(vaultPath);
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

    const entry = manifest.topics[topic];
    const topicName = topic as TopicName;
    const dir = topicDir(vaultPath, topicName);

    // Write the approved summary.md to vault with frontmatter
    await mkdir(dir, { recursive: true });
    const fm = generateFrontmatter({
      tier: 3,
      topic: topicName,
      type: 'summary',
      sourceCount: entry.fileCount,
    });
    const content = entry.summaryContent.replace(/^---[\s\S]*?---\n*/, '');
    await writeFile(join(dir, 'summary.md'), fm + content);

    delete manifest.topics[topic];
    results.push(`**${topic}** — approved and written to vault.`);
  }

  // Update or clear manifest
  await writeVaultPendingManifest(vaultPath, manifest);

  return results.join('\n');
}

async function handleVaultReject(vaultPath: string, arg: string): Promise<string> {
  const topic = arg.toLowerCase();
  const removed = await removeFromVaultManifest(vaultPath, topic);
  if (!removed) {
    return `Topic \`${topic}\` not found in pending manifest.`;
  }
  return `**${topic}** — rejected and removed from pending review.`;
}

// ---- Drive fallback (legacy) ----

async function handleDriveCommand(
  subcommand: string,
  arg: string,
): Promise<string> {
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
      return handleDrivePending(client, folderMap);
    case 'approve':
      if (!arg) return 'Usage: `!curator approve <topic>` or `!curator approve all`';
      return handleDriveApprove(client, folderMap, arg);
    case 'reject':
      if (!arg) return 'Usage: `!curator reject <topic>`';
      return handleDriveReject(client, folderMap, arg);
    default:
      return [
        `Unknown curator command: \`${subcommand}\``,
        'Available: `!curator pending`, `!curator approve <topic|all>`, `!curator reject <topic>`',
      ].join('\n');
  }
}

async function handleDrivePending(
  client: BrokerClient,
  folderMap: FolderMap,
): Promise<string> {
  const manifest = await readDriveManifest(client, folderMap);
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

async function handleDriveApprove(
  client: BrokerClient,
  folderMap: FolderMap,
  arg: string,
): Promise<string> {
  const manifest = await readDriveManifest(client, folderMap);
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

    await client.driveWrite('summary.md', entry.summaryContent, 'text', folderId);
    delete manifest.topics[topic];
    results.push(`**${topic}** — approved and written to Drive.`);
  }

  await writeDriveManifest(client, folderMap, manifest);

  return results.join('\n');
}

async function handleDriveReject(
  client: BrokerClient,
  folderMap: FolderMap,
  arg: string,
): Promise<string> {
  const topic = arg.toLowerCase();
  const removed = await removeFromDriveManifest(client, folderMap, topic);
  if (!removed) {
    return `Topic \`${topic}\` not found in pending manifest.`;
  }
  return `**${topic}** — rejected and removed from pending review.`;
}
