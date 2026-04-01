import type { TopicName } from './life-context-setup.js';
import type { ClassifiedItem } from './extraction-pipeline.js';

export interface TopicSummaryFiles {
  summary: string;
  timeline?: string;
  entities?: string;
}

export interface TopicSummaryResult {
  topic: TopicName;
  files: TopicSummaryFiles;
  requiresApproval: boolean;
  itemCount: number;
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

  if (tier === 3) {
    // Tier 3: minimal abstract summary only
    files.summary = generateTier3Summary(title, items);
  } else {
    // Tier 1-2: full detail
    files.summary = generateSummary(title, items);
    files.timeline = generateTimeline(title, items);
    files.entities = generateEntities(title, items);
  }

  return {
    topic,
    files,
    requiresApproval: tier === 3,
    itemCount: items.length,
  };
}

function generateSummary(title: string, items: ClassifiedItem[]): string {
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
    lines.push(`- **${item.subject}** (${item.date.split('T')[0]}) — ${item.snippet.slice(0, 100)}`);
  }
  if (items.length > 20) {
    lines.push(`- ... and ${items.length - 20} more items`);
  }
  lines.push('');

  return lines.join('\n');
}

function generateTimeline(title: string, items: ClassifiedItem[]): string {
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
  const lines = [`# ${title} — Timeline`, ''];

  for (const item of sorted) {
    const date = item.date.split('T')[0];
    const source = item.source === 'gmail' ? '📧' : '📅';
    lines.push(`- ${date} ${source} ${item.subject}`);
  }
  lines.push('');

  return lines.join('\n');
}

function generateEntities(title: string, items: ClassifiedItem[]): string {
  const lines = [`# ${title} — Entities`, ''];

  // Extract unique senders/organizers
  const people = new Map<string, number>();
  for (const item of items) {
    if (item.from) {
      people.set(item.from, (people.get(item.from) ?? 0) + 1);
    }
  }

  lines.push('## People / Contacts');
  lines.push('');
  const sorted = [...people.entries()].sort((a, b) => b[1] - a[1]);
  for (const [email, count] of sorted) {
    lines.push(`- ${email} (${count} interaction${count > 1 ? 's' : ''})`);
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
