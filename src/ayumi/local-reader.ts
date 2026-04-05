/**
 * Reads local markdown files and converts them to ClassifiedItems.
 * Used by the curator agent to ingest locally authored content
 * when the user provides file paths or a directory in chat.
 *
 * Primary interfaces:
 * - readLocalFiles(paths) — accepts specific file paths from the agent
 * - readLocalDirectory(dir) — reads all .md files from a directory
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import type { ClassifiedItem } from './extraction-pipeline.js';
import { classifyTopic } from './extraction-pipeline.js';

const TOPIC_TIER_MAP = {
  work: 2, travel: 1, finance: 3, health: 3, social: 2, hobbies: 1,
} as const;

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns the frontmatter fields and the body (content after frontmatter).
 */
export function parseFrontmatter(content: string): {
  fields: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)$/);
    if (kv) {
      fields[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }

  return { fields, body: match[2] };
}

/**
 * Extract the title from a markdown file.
 * Priority: frontmatter `title`, first `# heading`, filename.
 */
export function extractTitle(content: string, filename: string): string {
  const { fields, body } = parseFrontmatter(content);

  if (fields.title) return fields.title;

  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();

  return basename(filename, '.md').replace(/[-_]/g, ' ');
}

/**
 * Extract the date from a markdown file.
 * Priority: frontmatter `date`, filename date pattern (YYYY-MM-DD), file mtime.
 */
export function extractDate(
  content: string,
  filename: string,
  mtime: Date,
): string {
  const { fields } = parseFrontmatter(content);

  if (fields.date) return fields.date;

  // Try YYYY-MM-DD pattern in filename
  const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return `${dateMatch[1]}T00:00:00Z`;

  return mtime.toISOString();
}

/**
 * Classify a single file and return a ClassifiedItem.
 */
async function classifyFile(filePath: string): Promise<ClassifiedItem | null> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return null;

    const filename = basename(filePath);
    const content = await readFile(filePath, 'utf-8');
    const { body } = parseFrontmatter(content);
    const title = extractTitle(content, filename);
    const date = extractDate(content, filename, fileStat.mtime);
    const snippet = body.replace(/^#.*\n+/, '').trim().slice(0, 200);

    const topic = classifyTopic(title, snippet, filename);

    return {
      sourceId: filePath,
      source: 'local',
      topic,
      tier: TOPIC_TIER_MAP[topic],
      subject: title,
      date,
      from: filePath,
      snippet,
      body,
    };
  } catch (err) {
    console.warn(`[local-reader] Failed to read ${filePath}:`, err);
    return null;
  }
}

/**
 * Read specific file paths and return ClassifiedItems.
 * The agent calls this directly with paths from user chat.
 * Non-.md files and errors are skipped gracefully.
 */
export async function readLocalFiles(
  paths: string[],
): Promise<ClassifiedItem[]> {
  const items: ClassifiedItem[] = [];

  for (const filePath of paths) {
    const item = await classifyFile(filePath);
    if (item) items.push(item);
  }

  return items;
}

/**
 * Read all .md files from a directory and return ClassifiedItems.
 * Non-recursive — only reads files directly in the given directory.
 * The agent calls this when the user says "process all files in /path/to/dir".
 */
export async function readLocalDirectory(
  dirPath: string,
): Promise<ClassifiedItem[]> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch (err) {
    console.warn(`[local-reader] Cannot read directory ${dirPath}:`, err);
    return [];
  }

  const mdFiles = entries.filter((f) => f.endsWith('.md'));
  const paths = mdFiles.map((f) => join(dirPath, f));

  return readLocalFiles(paths);
}
