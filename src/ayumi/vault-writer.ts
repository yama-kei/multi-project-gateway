/**
 * Writes topic summaries to the local Obsidian vault filesystem.
 * Primary write target — replaces drive-writer.ts as the default write path.
 *
 * Responsibilities:
 * - Write summary.md, timeline.md, entities.md to vault/topics/{topic}/
 * - Add YAML frontmatter to every file
 * - Create/update entity pages in vault/entities/people/ and vault/entities/projects/
 * - Append to vault/_meta/audit.log
 * - Optionally sync to Drive when DRIVE_BACKUP_ENABLED=true
 */

import { mkdir, writeFile, readFile, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { TopicSummaryResult, EntityInfo } from './topic-summarizer.js';
import type { TopicName } from './life-context-setup.js';
import type { BrokerClient } from '../broker-client.js';
import type { FolderMap } from './life-context-setup.js';
import { writeTopicToDrive, type DriveWriterOptions, type PendingReviewManifest, type PendingTopicEntry } from './drive-writer.js';

export type { PendingReviewManifest, PendingTopicEntry };

export interface VaultWriterOptions {
  vaultPath: string;
  driveBackupEnabled?: boolean;
  /** Required when driveBackupEnabled is true */
  brokerClient?: BrokerClient;
  /** Required when driveBackupEnabled is true */
  folderMap?: FolderMap;
  /** Drive write options (e.g., approval flag for tier 3) */
  driveOptions?: DriveWriterOptions;
}

export interface VaultWriteResult {
  topic: string;
  written: boolean;
  filesWritten: string[];
  entitiesCreated: string[];
  entitiesUpdated: string[];
  driveBackedUp: boolean;
  skippedReason?: string;
}

const SENSITIVE_TOPICS: TopicName[] = ['finance', 'health'];

const TOPIC_TIER_MAP: Record<TopicName, 1 | 2 | 3> = {
  work: 2,
  travel: 1,
  finance: 3,
  health: 3,
  social: 2,
  hobbies: 1,
};

/**
 * Resolve the vault directory path for a topic.
 * Tier 3 topics go to topics/_sensitive/{topic}/.
 */
export function topicDir(vaultPath: string, topic: TopicName): string {
  if (SENSITIVE_TOPICS.includes(topic)) {
    return join(vaultPath, 'topics', '_sensitive', topic);
  }
  return join(vaultPath, 'topics', topic);
}

/**
 * Generate YAML frontmatter for a vault file.
 */
export function generateFrontmatter(opts: {
  tier: 1 | 2 | 3;
  topic: TopicName;
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

/**
 * Prepend frontmatter to content. If the content already starts with ---,
 * strip the existing frontmatter first.
 */
function prependFrontmatter(frontmatter: string, content: string): string {
  // Strip existing frontmatter if present
  const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
  return frontmatter + stripped;
}

/**
 * Compute date range string from a TopicSummaryResult.
 */
function computeDateRange(summary: TopicSummaryResult): string {
  if (summary.itemCount === 0) return '';
  // Extract dates from timeline content if available
  const content = summary.files.timeline ?? summary.files.summary;
  const dateMatches = content.match(/\d{4}-\d{2}-\d{2}/g);
  if (!dateMatches || dateMatches.length === 0) return '';
  const sorted = [...new Set(dateMatches)].sort();
  return `${sorted[0]} to ${sorted[sorted.length - 1]}`;
}

/**
 * Write a topic summary to the local vault.
 */
export async function writeTopicToVault(
  summary: TopicSummaryResult,
  options: VaultWriterOptions,
): Promise<VaultWriteResult> {
  const { vaultPath } = options;
  const topic = summary.topic;
  const tier = TOPIC_TIER_MAP[topic];
  const dir = topicDir(vaultPath, topic);
  const dateRange = computeDateRange(summary);

  // Tier 3 requires approval — write to pending manifest instead
  if (summary.requiresApproval && !options.driveOptions?.approved) {
    await addToVaultPendingManifest(vaultPath, summary);
    return {
      topic,
      written: false,
      filesWritten: [],
      entitiesCreated: [],
      entitiesUpdated: [],
      driveBackedUp: false,
      skippedReason: 'approval_required',
    };
  }

  // Ensure directory exists
  await mkdir(dir, { recursive: true });

  const filesWritten: string[] = [];

  // Write summary.md (always present)
  const summaryFm = generateFrontmatter({ tier, topic, type: 'summary', sourceCount: summary.itemCount, dateRange });
  await writeFile(join(dir, 'summary.md'), prependFrontmatter(summaryFm, summary.files.summary));
  filesWritten.push('summary.md');

  // Write timeline.md (tier 1-2 only)
  if (summary.files.timeline) {
    const timelineFm = generateFrontmatter({ tier, topic, type: 'timeline', sourceCount: summary.itemCount, dateRange });
    await writeFile(join(dir, 'timeline.md'), prependFrontmatter(timelineFm, summary.files.timeline));
    filesWritten.push('timeline.md');
  }

  // Write entities.md (tier 1-2 only)
  if (summary.files.entities) {
    const entitiesFm = generateFrontmatter({ tier, topic, type: 'entities', sourceCount: summary.itemCount, dateRange });
    await writeFile(join(dir, 'entities.md'), prependFrontmatter(entitiesFm, summary.files.entities));
    filesWritten.push('entities.md');
  }

  // Create/update entity pages
  const entitiesCreated: string[] = [];
  const entitiesUpdated: string[] = [];
  if (summary.entities) {
    for (const entity of summary.entities) {
      const result = await writeEntityPage(vaultPath, entity, topic, tier);
      if (result === 'created') entitiesCreated.push(entity.name);
      else if (result === 'updated') entitiesUpdated.push(entity.name);
    }
  }

  // Append to audit log
  await appendAuditLog(vaultPath, topic, filesWritten, entitiesCreated, entitiesUpdated);

  // Optional Drive backup
  let driveBackedUp = false;
  if (options.driveBackupEnabled && options.brokerClient && options.folderMap) {
    try {
      await writeTopicToDrive(options.brokerClient, options.folderMap, summary, options.driveOptions);
      driveBackedUp = true;
    } catch (err) {
      console.warn(`[vault-writer] Drive backup failed for ${topic}:`, err);
    }
  }

  return {
    topic,
    written: true,
    filesWritten,
    entitiesCreated,
    entitiesUpdated,
    driveBackedUp,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or update an entity page.
 * Returns 'created', 'updated', or 'skipped'.
 */
async function writeEntityPage(
  vaultPath: string,
  entity: EntityInfo,
  topic: TopicName,
  tier: 1 | 2 | 3,
): Promise<'created' | 'updated' | 'skipped'> {
  const subdir = entity.type === 'person' ? 'people' : 'projects';
  const entityDir = join(vaultPath, 'entities', subdir);
  const filePath = join(entityDir, `${entity.name}.md`);

  await mkdir(entityDir, { recursive: true });

  if (await fileExists(filePath)) {
    // Update: bump last_updated in frontmatter
    try {
      const existing = await readFile(filePath, 'utf-8');
      const now = new Date().toISOString().replace('Z', '+09:00').replace(/\.\d{3}/, '');
      const updated = existing.replace(
        /last_updated:\s*"[^"]*"/,
        `last_updated: "${now}"`,
      );
      await writeFile(filePath, updated);
      return 'updated';
    } catch {
      return 'skipped';
    }
  }

  // Create from template
  const aliases = entity.aliases?.length
    ? entity.aliases.map((a) => `  - "${a}"`).join('\n')
    : `  - "${entity.name}"`;

  const fm = generateFrontmatter({
    tier,
    topic,
    type: 'entity-page',
    sourceCount: 0,
    aliases: entity.aliases ?? [entity.name],
  });

  const roleLabel = entity.type === 'person' ? 'Role / Relationship' : 'Type';
  const content = [
    fm,
    `# ${entity.name}`,
    '',
    '## Overview',
    '',
    entity.context ?? `Referenced in ${topic} context.`,
    '',
    '## Key Details',
    '',
    `- **${roleLabel}**: ${entity.role ?? 'Unknown'}`,
    `- **First mentioned**: ${new Date().toISOString().split('T')[0]}`,
    `- **Context**: [[topics/${topic}/summary]]`,
    '',
    '## Timeline',
    '',
    `- **${new Date().toISOString().split('T')[0]}**: First referenced in ${topic} extraction`,
    '',
    '## Related',
    '',
    `- Topics: [[topics/${topic}/summary]]`,
    '',
  ].join('\n');

  await writeFile(filePath, content);
  return 'created';
}

/**
 * Append a write record to _meta/audit.log.
 */
async function appendAuditLog(
  vaultPath: string,
  topic: string,
  filesWritten: string[],
  entitiesCreated: string[],
  entitiesUpdated: string[],
): Promise<void> {
  const metaDir = join(vaultPath, '_meta');
  await mkdir(metaDir, { recursive: true });
  const logPath = join(metaDir, 'audit.log');

  const now = new Date().toISOString();
  const lines: string[] = [];
  for (const file of filesWritten) {
    lines.push(`${now} | write | topics/${topic}/${file}`);
  }
  for (const name of entitiesCreated) {
    lines.push(`${now} | create | entities/${name}.md`);
  }
  for (const name of entitiesUpdated) {
    lines.push(`${now} | update | entities/${name}.md`);
  }

  if (lines.length > 0) {
    await appendFile(logPath, lines.join('\n') + '\n');
  }
}

// ---- Vault-based pending review manifest ----

const MANIFEST_NAME = 'pending-review.json';

/**
 * Read the pending-review manifest from the vault _meta folder.
 * Returns null if no manifest exists or the file is empty/invalid.
 */
export async function readVaultPendingManifest(
  vaultPath: string,
): Promise<PendingReviewManifest | null> {
  try {
    const content = await readFile(join(vaultPath, '_meta', MANIFEST_NAME), 'utf-8');
    const parsed = JSON.parse(content);
    if (!parsed.topics || Object.keys(parsed.topics).length === 0) return null;
    return parsed as PendingReviewManifest;
  } catch {
    return null;
  }
}

/**
 * Write (or clear) the pending-review manifest in the vault _meta folder.
 */
export async function writeVaultPendingManifest(
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

/**
 * Add a tier-3 topic summary to the vault pending-review manifest.
 */
export async function addToVaultPendingManifest(
  vaultPath: string,
  summary: TopicSummaryResult,
): Promise<void> {
  const existing = await readVaultPendingManifest(vaultPath);
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
  await writeVaultPendingManifest(vaultPath, manifest);
}

/**
 * Remove a topic from the vault pending manifest.
 * Returns true if the topic was found and removed.
 */
export async function removeFromVaultManifest(
  vaultPath: string,
  topic: string,
): Promise<boolean> {
  const manifest = await readVaultPendingManifest(vaultPath);
  if (!manifest || !(topic in manifest.topics)) return false;
  delete manifest.topics[topic];
  await writeVaultPendingManifest(vaultPath, manifest);
  return true;
}
