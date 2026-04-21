/**
 * Loads life-context data for topic agents.
 *
 * Primary path: reads from local Obsidian vault via filesystem.
 * Fallback path: reads from Google Drive via broker (when VAULT_PATH is not set).
 *
 * Agent name → topic → vault path mapping:
 *   life-work    → vault/topics/work/
 *   life-travel  → vault/topics/travel/
 *   life-social  → vault/topics/social/
 *   life-hobbies → vault/topics/hobbies/
 *   life-finance → vault/topics/_sensitive/finance/
 *   life-health  → vault/topics/_sensitive/health/
 *
 * The loader emits a compact *index* of the topic's vault: summary.md body
 * (if present), a file listing with sizes and frontmatter descriptions, and
 * the _identity/writing-style.md body. The agent fetches individual files
 * on demand via the Read/Grep/Glob tools. The Discord/Slack adapters spawn
 * the CLI from the topic directory (see getLifeContextRunArgs) so the
 * default CWD-scoped permission model confines reads to that topic.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createBrokerClient, type BrokerClient, type DriveFile } from '../broker-client.js';
import type { Topic } from 'ayumi';

const AGENT_TOPIC_MAP: Record<string, Topic> = {
  'life-work': 'work',
  'life-travel': 'travel',
  'life-finance': 'finance',
  'life-health': 'health',
  'life-social': 'social',
  'life-hobbies': 'hobbies',
};

const SENSITIVE_TOPICS: Topic[] = ['finance', 'health'];

/** Re-resolve folder IDs after this many milliseconds (5 minutes). */
const FOLDER_CACHE_TTL_MS = 5 * 60 * 1000;

// Module-level singleton broker client (for Drive fallback)
let brokerClient: BrokerClient | null = null;
let envWarned = false;

// Cache the life-context folder ID and its topic subfolder IDs across calls.
let lifeContextFolderId: string | null = null;
let topicFolderIds: Record<string, string> | null = null;
let folderCacheTime = 0;

/**
 * Resolve the vault directory path for a topic.
 */
function topicVaultPath(vaultPath: string, topic: Topic): string {
  if (SENSITIVE_TOPICS.includes(topic)) {
    return join(vaultPath, 'topics', '_sensitive', topic);
  }
  return join(vaultPath, 'topics', topic);
}

export interface VaultIndexFile {
  name: string;
  sizeBytes: number;
  description: string | null;
}

export interface VaultIndex {
  summary: string | null;
  files: VaultIndexFile[];
}

function parseFrontmatterDescription(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const descLine = match[1].split('\n').find((l) => /^description:\s*/.test(l));
  if (!descLine) return null;
  const value = descLine.replace(/^description:\s*/, '').trim().replace(/^["']|["']$/g, '');
  return value || null;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '');
}

/**
 * Build a lightweight index of a topic's vault directory: summary.md body
 * (if present) plus per-file name/size/description for all .md files.
 * Returns null if the directory does not exist or has no .md files.
 */
export async function buildVaultIndex(vaultPath: string, topic: Topic): Promise<VaultIndex | null> {
  const dir = topicVaultPath(vaultPath, topic);
  let names: string[];
  try {
    const entries = await readdir(dir);
    names = entries.filter((f) => f.endsWith('.md')).sort();
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  const files: VaultIndexFile[] = [];
  let summary: string | null = null;

  for (const name of names) {
    try {
      const content = await readFile(join(dir, name), 'utf-8');
      files.push({
        name,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        description: parseFrontmatterDescription(content),
      });
      if (name === 'summary.md') {
        summary = stripFrontmatter(content);
      }
    } catch {
      continue;
    }
  }

  return { summary, files };
}

/**
 * Format a VaultIndex and optional writing-style body into an agent-facing
 * block. Kept separate so vault and Drive loaders share a single format.
 */
function formatIndexBlock(index: VaultIndex, writingStyleBody: string | null): string {
  const lines: string[] = ['--- LIFE CONTEXT INDEX ---', ''];

  if (index.summary) {
    lines.push('## summary.md', index.summary, '');
  }

  lines.push('## Available files in this topic');
  lines.push('Use the Read tool to fetch any of these when relevant to the question.');
  lines.push('Use the Grep tool to search across them.');
  lines.push('');
  for (const file of index.files) {
    if (file.name === 'summary.md') continue;
    const sizeKb = (file.sizeBytes / 1024).toFixed(1);
    const desc = file.description ? ` — ${file.description}` : '';
    lines.push(`- ${file.name} (${sizeKb} KB)${desc}`);
  }
  lines.push('');

  if (writingStyleBody) {
    lines.push('## writing-style.md', writingStyleBody, '');
  }

  lines.push('--- END LIFE CONTEXT INDEX ---');
  return lines.join('\n');
}

/**
 * Emit the index block for a local-filesystem vault. Returns null when the
 * topic directory is missing or empty.
 */
async function loadFromVault(vaultPath: string, topic: Topic): Promise<string | null> {
  const index = await buildVaultIndex(vaultPath, topic);
  if (!index) return null;

  let writingStyleBody: string | null = null;
  try {
    const content = await readFile(join(vaultPath, '_identity', 'writing-style.md'), 'utf-8');
    writingStyleBody = stripFrontmatter(content);
  } catch {
    // writing-style.md missing — continue without it
  }

  return formatIndexBlock(index, writingStyleBody);
}

/**
 * Load life-context for the given agent.
 *
 * If VAULT_PATH is set, reads from local vault filesystem (primary path).
 * Otherwise, falls back to Drive via broker (legacy path).
 *
 * @param agentName Agent preset name (e.g., 'life-work', 'life-travel')
 * @returns Index block to inject into the agent's system prompt, or null
 *          if not a life-context agent or loading fails.
 */
export async function loadLifeContext(agentName: string): Promise<string | null> {
  const topic = AGENT_TOPIC_MAP[agentName];
  if (!topic) return null;

  const vaultPath = process.env.VAULT_PATH;
  if (vaultPath) {
    try {
      return await loadFromVault(vaultPath, topic);
    } catch (err) {
      console.error(`[life-context-loader] Error loading vault context for ${agentName}:`, err);
      return null;
    }
  }

  return loadFromDrive(agentName, topic);
}

// ---- Drive fallback (legacy path) ----

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

async function loadFromDrive(agentName: string, topic: Topic): Promise<string | null> {
  const client = getOrCreateClient();
  if (!client) return null;

  try {
    const folderId = await resolveTopicFolderId(client, topic);
    if (!folderId) {
      console.error(`[life-context-loader] No folder found for topic "${topic}" in Drive`);
      return null;
    }

    const listing = await client.driveList(folderId);
    const mdFiles = listing.files
      .filter((f) => f.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (mdFiles.length === 0) {
      console.warn(`[life-context-loader] No .md files in ${topic} folder`);
      return null;
    }

    // Inline summary.md body; the rest are listed by name/size only.
    const summaryFile = mdFiles.find((f) => f.name === 'summary.md');
    let summary: string | null = null;
    if (summaryFile) {
      const result = await client.driveRead(summaryFile.file_id);
      summary = stripFrontmatter(result.content);
    }

    const files: VaultIndexFile[] = mdFiles.map((f) => ({
      name: f.name,
      sizeBytes: f.size_bytes ?? 0,
      description: null,
    }));

    return formatIndexBlock({ summary, files }, null);
  } catch (err) {
    console.error(`[life-context-loader] Error loading context for ${agentName}:`, err);
    return null;
  }
}

export interface LifeContextRunArgs {
  /** CWD to spawn Claude from — the topic directory. */
  cwd: string;
  /** Extra CLI args, notably `--add-dir` to grant writing-style.md access. */
  extraArgs: string[];
}

/**
 * Build the CLI spawn parameters that scope a topic agent's filesystem
 * access to its topic directory. Returns null for non-life-context agents
 * or when VAULT_PATH is unset.
 *
 * The Claude CLI scopes Read/Grep/Glob to the process CWD by default (when
 * permission checks are enforced). We spawn from the topic directory so
 * the agent cannot read sibling topics — e.g. @life-hobbies cannot read
 * vault/topics/_sensitive/finance/ or vault/topics/work/. We then add
 * vault/_identity/ via --add-dir so the agent can read writing-style.md.
 *
 * Note: --allowed-tools path patterns were tried first but the CLI's
 * permission matcher does not restrict CWD-scoped reads via --allowed-tools
 * (it's an extension mechanism for tools like Bash(git *), not a restrictor
 * for filesystem reads). CWD scoping is the enforceable mechanism.
 */
export function getLifeContextRunArgs(agentName: string): LifeContextRunArgs | null {
  const topic = AGENT_TOPIC_MAP[agentName];
  if (!topic) return null;

  const vaultPath = process.env.VAULT_PATH;
  if (!vaultPath) return null;

  const topicRoot = topicVaultPath(vaultPath, topic);
  const identityDir = join(vaultPath, '_identity');

  return {
    cwd: topicRoot,
    extraArgs: ['--add-dir', identityDir],
  };
}

/** Reset module-level state (for testing). */
export function _resetForTest(): void {
  brokerClient = null;
  envWarned = false;
  lifeContextFolderId = null;
  topicFolderIds = null;
  folderCacheTime = 0;
}
