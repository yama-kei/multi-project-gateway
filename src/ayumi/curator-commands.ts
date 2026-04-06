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
import type { Topic } from 'ayumi';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ---- Types (previously in drive-writer.ts / vault-writer.ts / life-context-setup.ts) ----

interface PendingTopicEntry {
  fileCount: number;
  totalSize: number;
  preview: string;
  summaryContent: string;
}

interface PendingReviewManifest {
  createdAt: string;
  topics: Record<string, PendingTopicEntry>;
}

interface FolderMap {
  root: string;
  topics: Record<Topic, string>;
  meta: string;
}

const TOPIC_FOLDERS: readonly Topic[] = ['work', 'travel', 'finance', 'health', 'social', 'hobbies'];
const SENSITIVE_TOPICS: Topic[] = ['finance', 'health'];
const MANIFEST_NAME = 'pending-review.json';

// ---- Vault helpers (previously in vault-writer.ts) ----

function topicDir(vaultPath: string, topic: Topic): string {
  if (SENSITIVE_TOPICS.includes(topic)) {
    return join(vaultPath, 'topics', '_sensitive', topic);
  }
  return join(vaultPath, 'topics', topic);
}

function generateFrontmatter(opts: {
  tier: 1 | 2 | 3;
  topic: Topic;
  type: 'summary' | 'timeline' | 'entities' | 'entity-page';
  sourceCount: number;
  dateRange?: string;
  aliases?: string[];
}): string {
  const now = new Date().toISOString().replace('Z', '+09:00').replace(/\.\d{3}/, '');
  const aliasLines = (opts.aliases ?? [`${opts.topic} ${opts.type}`])
    .map((a) => `  - "${a}"`)
    .join('\n');
  return [
    '---',
    `tier: ${opts.tier}`,
    `topic: ${opts.topic}`,
    `type: ${opts.type}`,
    `last_updated: "${now}"`,
    `source_count: ${opts.sourceCount}`,
    `date_range: "${opts.dateRange ?? ''}"`,
    `aliases:`,
    aliasLines,
    '---',
    '',
  ].join('\n');
}

async function readVaultPendingManifest(vaultPath: string): Promise<PendingReviewManifest | null> {
  try {
    const content = await readFile(join(vaultPath, '_meta', MANIFEST_NAME), 'utf-8');
    const parsed = JSON.parse(content);
    if (!parsed.topics || Object.keys(parsed.topics).length === 0) return null;
    return parsed as PendingReviewManifest;
  } catch {
    return null;
  }
}

async function writeVaultPendingManifest(
  vaultPath: string,
  manifest: PendingReviewManifest | null,
): Promise<void> {
  const metaDir = join(vaultPath, '_meta');
  await mkdir(metaDir, { recursive: true });
  const filePath = join(metaDir, MANIFEST_NAME);

  if (!manifest || Object.keys(manifest.topics).length === 0) {
    await writeFile(filePath, '{}');
    return;
  }
  await writeFile(filePath, JSON.stringify(manifest, null, 2));
}

async function removeFromVaultManifest(vaultPath: string, topic: string): Promise<boolean> {
  const manifest = await readVaultPendingManifest(vaultPath);
  if (!manifest || !(topic in manifest.topics)) return false;
  delete manifest.topics[topic];
  await writeVaultPendingManifest(vaultPath, manifest);
  return true;
}

// ---- Drive helpers (previously in drive-writer.ts / life-context-setup.ts) ----

async function ensureLifeContextFolders(client: BrokerClient): Promise<FolderMap> {
  const existing = await loadExistingMap(client);
  if (existing && isComplete(existing)) return existing;

  const map: FolderMap = existing ?? {
    root: '',
    topics: { work: '', travel: '', finance: '', health: '', social: '', hobbies: '' },
    meta: '',
  };

  if (!map.root) {
    const result = await client.driveCreateFolder('life-context', undefined);
    map.root = result.folder_id;
  }

  for (const topic of TOPIC_FOLDERS) {
    if (!map.topics[topic]) {
      const result = await client.driveCreateFolder(topic, map.root);
      map.topics[topic] = result.folder_id;
    }
  }

  if (!map.meta) {
    const result = await client.driveCreateFolder('_meta', map.root);
    map.meta = result.folder_id;
  }

  await client.driveWrite(FOLDER_MAP_NAME, JSON.stringify(map, null, 2), 'text');
  return map;
}

const FOLDER_MAP_NAME = 'folder-map.json';

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

async function readDriveManifest(
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

async function writeDriveManifest(
  client: BrokerClient,
  folderMap: FolderMap,
  manifest: PendingReviewManifest | null,
): Promise<void> {
  if (!manifest || Object.keys(manifest.topics).length === 0) {
    await client.driveWrite(MANIFEST_NAME, '{}', 'text', folderMap.meta);
    return;
  }
  await client.driveWrite(MANIFEST_NAME, JSON.stringify(manifest, null, 2), 'text', folderMap.meta);
}

async function removeFromDriveManifest(
  client: BrokerClient,
  folderMap: FolderMap,
  topic: string,
): Promise<boolean> {
  const manifest = await readDriveManifest(client, folderMap);
  if (!manifest || !(topic in manifest.topics)) return false;
  delete manifest.topics[topic];
  await writeDriveManifest(client, folderMap, manifest);
  return true;
}

// ---- Public API ----

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
    const topicName = topic as Topic;
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

    const folderId = folderMap.topics[topic as Topic];
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
