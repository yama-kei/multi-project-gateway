import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeTopicToVault,
  generateFrontmatter,
  topicDir,
  readVaultPendingManifest,
  writeVaultPendingManifest,
  addToVaultPendingManifest,
  removeFromVaultManifest,
  type VaultWriterOptions,
} from '../../src/ayumi/vault-writer.js';
import type { TopicSummaryResult } from '../../src/ayumi/topic-summarizer.js';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'vault-writer-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function defaultOptions(): VaultWriterOptions {
  return { vaultPath: tempDir };
}

describe('topicDir', () => {
  it('returns topics/{topic}/ for tier 1-2 topics', () => {
    expect(topicDir('/vault', 'work')).toBe('/vault/topics/work');
    expect(topicDir('/vault', 'travel')).toBe('/vault/topics/travel');
  });

  it('returns topics/_sensitive/{topic}/ for tier 3 topics', () => {
    expect(topicDir('/vault', 'finance')).toBe('/vault/topics/_sensitive/finance');
    expect(topicDir('/vault', 'health')).toBe('/vault/topics/_sensitive/health');
  });
});

describe('generateFrontmatter', () => {
  it('generates valid YAML frontmatter', () => {
    const fm = generateFrontmatter({
      tier: 2,
      topic: 'work',
      type: 'summary',
      sourceCount: 10,
      dateRange: '2026-01-01 to 2026-03-31',
    });

    expect(fm).toContain('---');
    expect(fm).toContain('tier: 2');
    expect(fm).toContain('topic: work');
    expect(fm).toContain('type: summary');
    expect(fm).toContain('source_count: 10');
    expect(fm).toContain('date_range: "2026-01-01 to 2026-03-31"');
    expect(fm).toContain('last_updated:');
  });

  it('includes aliases', () => {
    const fm = generateFrontmatter({
      tier: 1,
      topic: 'travel',
      type: 'timeline',
      sourceCount: 5,
      aliases: ['travel timeline', 'trips'],
    });

    expect(fm).toContain('"travel timeline"');
    expect(fm).toContain('"trips"');
  });
});

describe('writeTopicToVault', () => {
  it('writes summary.md, timeline.md, entities.md for tier 1-2 topics', async () => {
    const summary: TopicSummaryResult = {
      topic: 'work',
      files: {
        summary: '# Work — Summary\n\nProject updates.',
        timeline: '# Work — Timeline\n\n- 2026-01-15 Sprint Planning',
        entities: '# Work — Entities\n\n## People\n- [[Boss]]',
      },
      requiresApproval: false,
      itemCount: 5,
    };

    const result = await writeTopicToVault(summary, defaultOptions());

    expect(result.written).toBe(true);
    expect(result.filesWritten).toEqual(['summary.md', 'timeline.md', 'entities.md']);

    // Verify files exist with frontmatter
    const summaryContent = await readFile(join(tempDir, 'topics', 'work', 'summary.md'), 'utf-8');
    expect(summaryContent).toContain('---');
    expect(summaryContent).toContain('tier: 2');
    expect(summaryContent).toContain('topic: work');
    expect(summaryContent).toContain('type: summary');
    expect(summaryContent).toContain('Project updates.');

    const timelineContent = await readFile(join(tempDir, 'topics', 'work', 'timeline.md'), 'utf-8');
    expect(timelineContent).toContain('type: timeline');
    expect(timelineContent).toContain('Sprint Planning');
  });

  it('writes only summary.md for tier 3 topics when approved', async () => {
    const summary: TopicSummaryResult = {
      topic: 'finance',
      files: { summary: '# Finance — Summary\n\n3 items found.' },
      requiresApproval: true,
      itemCount: 3,
    };

    const result = await writeTopicToVault(summary, {
      ...defaultOptions(),
      driveOptions: { approved: true },
    });

    expect(result.written).toBe(true);
    expect(result.filesWritten).toEqual(['summary.md']);

    // Tier 3 writes to _sensitive/
    const content = await readFile(join(tempDir, 'topics', '_sensitive', 'finance', 'summary.md'), 'utf-8');
    expect(content).toContain('tier: 3');
    expect(content).toContain('topic: finance');
  });

  it('skips write for tier 3 when not approved', async () => {
    const summary: TopicSummaryResult = {
      topic: 'health',
      files: { summary: '# Health — Summary' },
      requiresApproval: true,
      itemCount: 2,
    };

    const result = await writeTopicToVault(summary, defaultOptions());

    expect(result.written).toBe(false);
    expect(result.skippedReason).toBe('approval_required');
    expect(result.filesWritten).toEqual([]);
  });

  it('creates entity pages for discovered entities', async () => {
    const summary: TopicSummaryResult = {
      topic: 'work',
      files: {
        summary: '# Work — Summary\n\nMet with [[Tanaka Kenji]].',
        timeline: '# Timeline\n\n- 2026-01-15 Meeting',
        entities: '# Entities\n\n| [[Tanaka Kenji]] |',
      },
      requiresApproval: false,
      itemCount: 5,
      entities: [
        { name: 'Tanaka Kenji', type: 'person', role: 'colleague', aliases: ['Kenji', 'Tanaka-san'] },
      ],
    };

    const result = await writeTopicToVault(summary, defaultOptions());

    expect(result.entitiesCreated).toEqual(['Tanaka Kenji']);

    const entityContent = await readFile(join(tempDir, 'entities', 'people', 'Tanaka Kenji.md'), 'utf-8');
    expect(entityContent).toContain('type: entity-page');
    expect(entityContent).toContain('# Tanaka Kenji');
    expect(entityContent).toContain('[[topics/work/summary]]');
  });

  it('creates project entity pages', async () => {
    const summary: TopicSummaryResult = {
      topic: 'work',
      files: { summary: '# Work', timeline: '# Timeline', entities: '# Entities' },
      requiresApproval: false,
      itemCount: 3,
      entities: [
        { name: 'Project Aurora', type: 'project', role: 'platform migration' },
      ],
    };

    const result = await writeTopicToVault(summary, defaultOptions());

    expect(result.entitiesCreated).toEqual(['Project Aurora']);

    const content = await readFile(join(tempDir, 'entities', 'projects', 'Project Aurora.md'), 'utf-8');
    expect(content).toContain('# Project Aurora');
  });

  it('updates existing entity pages (bumps last_updated)', async () => {
    // First write creates the entity
    const summary: TopicSummaryResult = {
      topic: 'work',
      files: { summary: '# Work', timeline: '# Timeline', entities: '# Entities' },
      requiresApproval: false,
      itemCount: 3,
      entities: [
        { name: 'Tanaka Kenji', type: 'person', role: 'colleague' },
      ],
    };

    await writeTopicToVault(summary, defaultOptions());

    // Second write updates
    const result = await writeTopicToVault(summary, defaultOptions());

    expect(result.entitiesCreated).toEqual([]);
    expect(result.entitiesUpdated).toEqual(['Tanaka Kenji']);
  });

  it('appends to audit.log', async () => {
    const summary: TopicSummaryResult = {
      topic: 'travel',
      files: {
        summary: '# Travel — Summary\n\nTrip to Tokyo.',
        timeline: '# Travel — Timeline',
        entities: '# Travel — Entities',
      },
      requiresApproval: false,
      itemCount: 2,
    };

    await writeTopicToVault(summary, defaultOptions());

    const auditLog = await readFile(join(tempDir, '_meta', 'audit.log'), 'utf-8');
    expect(auditLog).toContain('topics/travel/summary.md');
    expect(auditLog).toContain('topics/travel/timeline.md');
    expect(auditLog).toContain('topics/travel/entities.md');
  });

  it('creates directories if they do not exist', async () => {
    const summary: TopicSummaryResult = {
      topic: 'hobbies',
      files: { summary: '# Hobbies\n\nRunning.', timeline: '# Timeline', entities: '# Entities' },
      requiresApproval: false,
      itemCount: 1,
    };

    const result = await writeTopicToVault(summary, defaultOptions());

    expect(result.written).toBe(true);
    const s = await stat(join(tempDir, 'topics', 'hobbies'));
    expect(s.isDirectory()).toBe(true);
  });

  it('strips existing frontmatter before prepending new', async () => {
    const summary: TopicSummaryResult = {
      topic: 'work',
      files: {
        summary: '---\ntier: 1\n---\n# Work — Summary\n\nContent.',
      },
      requiresApproval: false,
      itemCount: 1,
    };

    await writeTopicToVault(summary, defaultOptions());

    const content = await readFile(join(tempDir, 'topics', 'work', 'summary.md'), 'utf-8');
    // Should have exactly one frontmatter block
    const matches = content.match(/---/g);
    expect(matches?.length).toBe(2); // opening and closing ---
    expect(content).toContain('tier: 2'); // correct tier, not the old tier: 1
  });

  it('writes tier 3 content to pending manifest when not approved', async () => {
    const summary: TopicSummaryResult = {
      topic: 'health',
      files: { summary: '# Health — Summary\n\n2 items.' },
      requiresApproval: true,
      itemCount: 2,
    };

    const result = await writeTopicToVault(summary, defaultOptions());

    expect(result.written).toBe(false);
    expect(result.skippedReason).toBe('approval_required');

    // Verify manifest was written
    const manifest = await readVaultPendingManifest(tempDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.topics.health).toBeDefined();
    expect(manifest!.topics.health.summaryContent).toContain('# Health — Summary');
  });
});

describe('vault pending manifest', () => {
  it('readVaultPendingManifest returns null when no manifest exists', async () => {
    const result = await readVaultPendingManifest(tempDir);
    expect(result).toBeNull();
  });

  it('readVaultPendingManifest returns null for empty manifest', async () => {
    await mkdir(join(tempDir, '_meta'), { recursive: true });
    await writeFile(join(tempDir, '_meta', 'pending-review.json'), '{}');
    const result = await readVaultPendingManifest(tempDir);
    expect(result).toBeNull();
  });

  it('writeVaultPendingManifest creates _meta dir and writes manifest', async () => {
    const manifest = {
      createdAt: '2026-04-01T10:00:00Z',
      topics: {
        finance: { fileCount: 1, totalSize: 100, preview: 'preview', summaryContent: 'full content' },
      },
    };
    await writeVaultPendingManifest(tempDir, manifest);

    const content = await readFile(join(tempDir, '_meta', 'pending-review.json'), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.topics.finance.summaryContent).toBe('full content');
  });

  it('writeVaultPendingManifest clears manifest when empty', async () => {
    await writeVaultPendingManifest(tempDir, { createdAt: '2026-04-01T10:00:00Z', topics: {} });
    const content = await readFile(join(tempDir, '_meta', 'pending-review.json'), 'utf-8');
    expect(content).toBe('{}');
  });

  it('writeVaultPendingManifest clears manifest when null', async () => {
    await writeVaultPendingManifest(tempDir, null);
    const content = await readFile(join(tempDir, '_meta', 'pending-review.json'), 'utf-8');
    expect(content).toBe('{}');
  });

  it('addToVaultPendingManifest adds a topic', async () => {
    const summary: TopicSummaryResult = {
      topic: 'finance',
      files: { summary: '# Finance Summary\n\nSensitive data.' },
      requiresApproval: true,
      itemCount: 3,
    };
    await addToVaultPendingManifest(tempDir, summary);

    const manifest = await readVaultPendingManifest(tempDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.topics.finance).toBeDefined();
    expect(manifest!.topics.finance.summaryContent).toContain('# Finance Summary');
    expect(manifest!.topics.finance.preview.length).toBeLessThanOrEqual(200);
  });

  it('addToVaultPendingManifest appends to existing manifest', async () => {
    const summary1: TopicSummaryResult = {
      topic: 'finance',
      files: { summary: '# Finance' },
      requiresApproval: true,
      itemCount: 1,
    };
    const summary2: TopicSummaryResult = {
      topic: 'health',
      files: { summary: '# Health' },
      requiresApproval: true,
      itemCount: 2,
    };
    await addToVaultPendingManifest(tempDir, summary1);
    await addToVaultPendingManifest(tempDir, summary2);

    const manifest = await readVaultPendingManifest(tempDir);
    expect(Object.keys(manifest!.topics)).toEqual(['finance', 'health']);
  });

  it('removeFromVaultManifest removes a topic', async () => {
    const manifest = {
      createdAt: '2026-04-01T10:00:00Z',
      topics: {
        finance: { fileCount: 1, totalSize: 100, preview: 'p', summaryContent: 'full' },
        health: { fileCount: 1, totalSize: 80, preview: 'p2', summaryContent: 'full2' },
      },
    };
    await writeVaultPendingManifest(tempDir, manifest);

    const removed = await removeFromVaultManifest(tempDir, 'finance');
    expect(removed).toBe(true);

    const updated = await readVaultPendingManifest(tempDir);
    expect(updated!.topics.health).toBeDefined();
    expect(updated!.topics.finance).toBeUndefined();
  });

  it('removeFromVaultManifest returns false for unknown topic', async () => {
    const removed = await removeFromVaultManifest(tempDir, 'travel');
    expect(removed).toBe(false);
  });
});
