import type { TopicName } from './life-context-setup.js';
import type { ClassifiedItem } from './extraction-pipeline.js';

export interface TopicSummaryFiles {
  summary: string;
  timeline?: string;
  entities?: string;
}

export interface EntityInfo {
  name: string;
  type: 'person' | 'project';
  role?: string;
  context?: string;
  aliases?: string[];
}

export interface TopicSummaryResult {
  topic: TopicName;
  files: TopicSummaryFiles;
  requiresApproval: boolean;
  itemCount: number;
  /** Entities discovered during summarization, for vault-writer entity page creation. */
  entities?: EntityInfo[];
}

const TOPIC_TIER_MAP: Record<TopicName, 1 | 2 | 3> = {
  work: 2,
  travel: 1,
  finance: 3,
  health: 3,
  social: 2,
  hobbies: 1,
};

export function summarizeTopic(topic: TopicName, items: ClassifiedItem[]): TopicSummaryResult {
  const tier = TOPIC_TIER_MAP[topic];
  const title = topic.charAt(0).toUpperCase() + topic.slice(1);

  if (items.length === 0) {
    return {
      topic,
      files: { summary: `# ${title} — Summary\n\nNo items found for this topic in the scanned time range.\n` },
      requiresApproval: tier === 3,
      itemCount: 0,
    };
  }

  const files: TopicSummaryFiles = { summary: '' };
  let entities: EntityInfo[] | undefined;

  if (tier === 3) {
    // Tier 3: minimal abstract summary only
    files.summary = generateTier3Summary(title, items);
  } else {
    // Tier 1-2: full detail with wikilinks
    entities = extractEntities(items);
    const entityNames = new Set(entities.map((e) => e.name));
    files.summary = generateSummary(title, items, entityNames);
    files.timeline = generateTimeline(title, items, entityNames);
    files.entities = generateEntities(title, items, entities);
  }

  return {
    topic,
    files,
    requiresApproval: tier === 3,
    itemCount: items.length,
    entities,
  };
}

/**
 * Extract entity info from classified items.
 * Parses email addresses to derive person names and identifies entities
 * for entity page creation by vault-writer.
 */
function extractEntities(items: ClassifiedItem[]): EntityInfo[] {
  const people = new Map<string, { email: string; count: number }>();

  for (const item of items) {
    if (item.from) {
      const name = emailToName(item.from);
      const existing = people.get(name);
      if (existing) {
        existing.count++;
      } else {
        people.set(name, { email: item.from, count: 1 });
      }
    }
  }

  return [...people.entries()].map(([name, info]) => ({
    name,
    type: 'person' as const,
    role: 'contact',
    context: `${info.count} interaction(s) via ${info.email}`,
    aliases: [info.email],
  }));
}

/**
 * Convert email address to a display name.
 * "tanaka.kenji@company.com" → "Tanaka Kenji"
 */
function emailToName(email: string): string {
  const local = email.split('@')[0];
  return local
    .split(/[._-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Wrap a name in [[wikilinks]] if it appears in the known entities set.
 * Only links entity names, not dates or generic terms.
 */
export function applyWikilinks(text: string, entityNames: Set<string>): string {
  let result = text;
  // Sort by length descending to avoid partial matches
  const sorted = [...entityNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    // Replace occurrences not already inside [[ ]]
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<!\\[\\[)\\b${escaped}\\b(?!\\]\\])`, 'g');
    result = result.replace(regex, `[[${name}]]`);
  }
  return result;
}

function generateSummary(title: string, items: ClassifiedItem[], entityNames: Set<string>): string {
  const lines = [`# ${title} — Summary`, ''];
  lines.push(`${items.length} items found.`);
  lines.push('');

  const bySource = { gmail: 0, calendar: 0 };
  for (const item of items) bySource[item.source]++;

  lines.push(`- ${bySource.gmail} email(s), ${bySource.calendar} calendar event(s)`);
  lines.push('');

  lines.push('## Key Topics');
  lines.push('');
  for (const item of items.slice(0, 20)) {
    const line = `- **${item.subject}** (${item.date.split('T')[0]}) — ${item.snippet.slice(0, 100)}`;
    lines.push(applyWikilinks(line, entityNames));
  }
  if (items.length > 20) {
    lines.push(`- ... and ${items.length - 20} more items`);
  }
  lines.push('');

  return lines.join('\n');
}

function generateTimeline(title: string, items: ClassifiedItem[], entityNames: Set<string>): string {
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
  const lines = [`# ${title} — Timeline`, ''];

  for (const item of sorted) {
    const date = item.date.split('T')[0];
    const source = item.source === 'gmail' ? '📧' : '📅';
    const line = `- ${date} ${source} ${item.subject}`;
    lines.push(applyWikilinks(line, entityNames));
  }
  lines.push('');

  return lines.join('\n');
}

function generateEntities(title: string, items: ClassifiedItem[], entities: EntityInfo[]): string {
  const lines = [`# ${title} — Entities`, ''];

  lines.push('## People / Contacts');
  lines.push('');
  lines.push('| Name | Role | Interactions |');
  lines.push('|------|------|-------------|');

  // Count interactions per entity
  const countMap = new Map<string, number>();
  for (const item of items) {
    if (item.from) {
      const name = emailToName(item.from);
      countMap.set(name, (countMap.get(name) ?? 0) + 1);
    }
  }

  const sorted = [...countMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    lines.push(`| [[${name}]] | contact | ${count} |`);
  }
  lines.push('');

  return lines.join('\n');
}

function generateTier3Summary(title: string, items: ClassifiedItem[]): string {
  const lines = [`# ${title} — Summary`, ''];
  lines.push(`${items.length} item(s) found in this sensitive category.`);
  lines.push('');
  lines.push('This is a high-sensitivity topic (tier 3). Only aggregate counts are included.');
  lines.push('');

  const bySource = { gmail: 0, calendar: 0 };
  for (const item of items) bySource[item.source]++;

  lines.push(`- ${bySource.gmail} email(s), ${bySource.calendar} calendar event(s)`);
  lines.push(`- Date range: ${items[0]?.date.split('T')[0] ?? 'N/A'} to ${items[items.length - 1]?.date.split('T')[0] ?? 'N/A'}`);
  lines.push('');

  return lines.join('\n');
}
