import { describe, it, expect, vi } from 'vitest';
import {
  writeTopicToDrive,
  writeDeltaToDrive,
  readPendingManifest,
  writePendingManifest,
  removeFromManifest,
  type DriveWriterOptions,
  type PendingReviewManifest,
  type DeltaContent,
  type DeltaWriteOptions,
} from '../../src/ayumi/drive-writer.js';
import type { BrokerClient } from '../../src/broker-client.js';
import type { FolderMap } from '../../src/ayumi/life-context-setup.js';
import type { TopicSummaryResult } from '../../src/ayumi/topic-summarizer.js';

function mockClient(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    health: vi.fn(),
    gmailSearch: vi.fn(),
    gmailMessages: vi.fn(),
    calendarEvents: vi.fn(),
    driveRead: vi.fn(),
    driveWrite: vi.fn().mockResolvedValue({ file_id: 'new-id', name: 'summary.md', mime_type: 'text/plain', web_view_link: null }),
    driveSearch: vi.fn(),
    driveCreateFolder: vi.fn(),
    driveList: vi.fn(),
    ...overrides,
  };
}

const testFolderMap: FolderMap = {
  root: 'root-id',
  topics: { work: 'work-id', travel: 'travel-id', finance: 'finance-id', health: 'health-id', social: 'social-id', hobbies: 'hobbies-id' },
  meta: 'meta-id',
};

describe('writeTopicToDrive', () => {
  it('writes summary.md, timeline.md, entities.md for tier 1-2 topics', async () => {
    const client = mockClient();
    const summary: TopicSummaryResult = {
      topic: 'work',
      files: {
        summary: '# Work — Summary\n\n...',
        timeline: '# Work — Timeline\n\n...',
        entities: '# Work — Entities\n\n...',
      },
      requiresApproval: false,
      itemCount: 5,
    };

    const result = await writeTopicToDrive(client, testFolderMap, summary);

    expect(result.written).toBe(true);
    expect(client.driveWrite).toHaveBeenCalledTimes(3);
    expect(client.driveWrite).toHaveBeenCalledWith('summary.md', summary.files.summary, 'text', 'work-id');
    expect(client.driveWrite).toHaveBeenCalledWith('timeline.md', summary.files.timeline, 'text', 'work-id');
    expect(client.driveWrite).toHaveBeenCalledWith('entities.md', summary.files.entities, 'text', 'work-id');
  });

  it('writes only summary.md for tier 3 topics when approved', async () => {
    const client = mockClient();
    const summary: TopicSummaryResult = {
      topic: 'finance',
      files: { summary: '# Finance — Summary\n\n...' },
      requiresApproval: true,
      itemCount: 3,
    };

    const result = await writeTopicToDrive(client, testFolderMap, summary, { approved: true });

    expect(result.written).toBe(true);
    expect(client.driveWrite).toHaveBeenCalledTimes(1);
    expect(client.driveWrite).toHaveBeenCalledWith('summary.md', summary.files.summary, 'text', 'finance-id');
  });

  it('skips topic write for tier 3 when not approved, but writes manifest', async () => {
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({ files: [] }),
    });
    const summary: TopicSummaryResult = {
      topic: 'health',
      files: { summary: '# Health — Summary\n\n...' },
      requiresApproval: true,
      itemCount: 2,
    };

    const result = await writeTopicToDrive(client, testFolderMap, summary, { approved: false });

    expect(result.written).toBe(false);
    expect(result.skippedReason).toBe('approval_required');
    // Should NOT write summary.md to the topic folder
    expect(client.driveWrite).not.toHaveBeenCalledWith('summary.md', expect.anything(), expect.anything(), 'health-id');
    // Should write pending-review manifest
    expect(client.driveWrite).toHaveBeenCalledWith('pending-review.json', expect.stringContaining('"health"'), 'text', 'meta-id');
  });

  it('defaults to not approved for tier 3 topics', async () => {
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({ files: [] }),
    });
    const summary: TopicSummaryResult = {
      topic: 'health',
      files: { summary: '# Health — Summary\n\n...' },
      requiresApproval: true,
      itemCount: 2,
    };

    const result = await writeTopicToDrive(client, testFolderMap, summary);

    expect(result.written).toBe(false);
  });

  it('writes pending-review manifest when tier 3 is skipped', async () => {
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({ files: [] }),
    });
    const summary: TopicSummaryResult = {
      topic: 'finance',
      files: { summary: '# Finance — Summary\n\nSensitive data here.' },
      requiresApproval: true,
      itemCount: 3,
    };

    await writeTopicToDrive(client, testFolderMap, summary);

    // Should have written the manifest to the meta folder
    expect(client.driveWrite).toHaveBeenCalledWith(
      'pending-review.json',
      expect.stringContaining('"finance"'),
      'text',
      'meta-id',
    );
  });
});

describe('readPendingManifest', () => {
  it('returns null when no manifest file exists', async () => {
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({ files: [] }),
    });
    const result = await readPendingManifest(client, testFolderMap);
    expect(result).toBeNull();
  });

  it('reads and parses existing manifest', async () => {
    const manifest: PendingReviewManifest = {
      createdAt: '2026-04-01T10:00:00Z',
      topics: {
        finance: { fileCount: 1, totalSize: 100, preview: 'preview text', summaryContent: 'full content' },
      },
    };
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({
        files: [{ file_id: 'manifest-id', name: 'pending-review.json', mime_type: 'text/plain', size_bytes: 100, modified_at: '2026-04-01T10:00:00Z', web_view_link: null }],
      }),
      driveRead: vi.fn().mockResolvedValue({ name: 'pending-review.json', mime_type: 'text/plain', content: JSON.stringify(manifest) }),
    });

    const result = await readPendingManifest(client, testFolderMap);
    expect(result).toEqual(manifest);
  });

  it('returns null on error', async () => {
    const client = mockClient({
      driveList: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const result = await readPendingManifest(client, testFolderMap);
    expect(result).toBeNull();
  });
});

describe('writePendingManifest', () => {
  it('writes manifest to meta folder', async () => {
    const client = mockClient();
    const manifest: PendingReviewManifest = {
      createdAt: '2026-04-01T10:00:00Z',
      topics: { finance: { fileCount: 1, totalSize: 100, preview: 'preview', summaryContent: 'full' } },
    };

    await writePendingManifest(client, testFolderMap, manifest);
    expect(client.driveWrite).toHaveBeenCalledWith(
      'pending-review.json',
      JSON.stringify(manifest, null, 2),
      'text',
      'meta-id',
    );
  });

  it('writes empty object when manifest has no topics', async () => {
    const client = mockClient();
    await writePendingManifest(client, testFolderMap, { createdAt: '2026-04-01T10:00:00Z', topics: {} });
    expect(client.driveWrite).toHaveBeenCalledWith('pending-review.json', '{}', 'text', 'meta-id');
  });

  it('writes empty object when manifest is null', async () => {
    const client = mockClient();
    await writePendingManifest(client, testFolderMap, null);
    expect(client.driveWrite).toHaveBeenCalledWith('pending-review.json', '{}', 'text', 'meta-id');
  });
});

describe('removeFromManifest', () => {
  it('removes topic and updates manifest', async () => {
    const manifest: PendingReviewManifest = {
      createdAt: '2026-04-01T10:00:00Z',
      topics: {
        finance: { fileCount: 1, totalSize: 100, preview: 'p', summaryContent: 'full' },
        health: { fileCount: 1, totalSize: 80, preview: 'p2', summaryContent: 'full2' },
      },
    };
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({
        files: [{ file_id: 'manifest-id', name: 'pending-review.json', mime_type: 'text/plain', size_bytes: 100, modified_at: '2026-04-01T10:00:00Z', web_view_link: null }],
      }),
      driveRead: vi.fn().mockResolvedValue({ name: 'pending-review.json', mime_type: 'text/plain', content: JSON.stringify(manifest) }),
    });

    const result = await removeFromManifest(client, testFolderMap, 'finance');
    expect(result).toBe(true);
    expect(client.driveWrite).toHaveBeenCalledWith(
      'pending-review.json',
      expect.stringContaining('"health"'),
      'text',
      'meta-id',
    );
  });

  it('returns false when topic not in manifest', async () => {
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({ files: [] }),
    });
    const result = await removeFromManifest(client, testFolderMap, 'travel');
    expect(result).toBe(false);
  });
});

describe('writeDeltaToDrive', () => {
  const deltaOptions: DeltaWriteOptions = {
    scanRange: { start: '2026-04-07', end: '2026-04-13' },
    sourceCounts: { gmail: 5, calendar: 2 },
  };

  it('writes delta file with frontmatter for tier 1-2 topics', async () => {
    const client = mockClient();
    const delta: DeltaContent = {
      topic: 'travel',
      content: '## New Travel activity\n\n- 2026-04-10 Flight booking',
      requiresApproval: false,
    };

    const result = await writeDeltaToDrive(client, testFolderMap, delta, deltaOptions);

    expect(result.written).toBe(true);
    expect(result.filesWritten).toEqual(['delta-2026-04-13.md']);
    expect(client.driveWrite).toHaveBeenCalledWith(
      'delta-2026-04-13.md',
      expect.stringContaining('type: delta'),
      'text',
      'travel-id',
    );
    // Verify frontmatter format
    const writtenContent = (client.driveWrite as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(writtenContent).toContain('scan_range: 2026-04-07 to 2026-04-13');
    expect(writtenContent).toContain('source_counts: { gmail: 5, calendar: 2 }');
    expect(writtenContent).toContain('## New Travel activity');
  });

  it('sends tier-3 deltas to pending-review manifest', async () => {
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({ files: [] }),
    });
    const delta: DeltaContent = {
      topic: 'finance',
      content: '## New Finance activity\n\n- 2026-04-10 Payment received',
      requiresApproval: true,
    };

    const result = await writeDeltaToDrive(client, testFolderMap, delta, deltaOptions);

    expect(result.written).toBe(false);
    expect(result.skippedReason).toBe('approval_required');
    // Should write manifest, not the delta file directly
    expect(client.driveWrite).toHaveBeenCalledWith(
      'pending-review.json',
      expect.stringContaining('"finance"'),
      'text',
      'meta-id',
    );
    // The manifest should contain the full delta content with frontmatter
    const manifestContent = (client.driveWrite as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(manifestContent);
    expect(parsed.topics.finance.summaryContent).toContain('type: delta');
    expect(parsed.topics.finance.summaryContent).toContain('## New Finance activity');
  });

  it('uses scan range end date for file naming', async () => {
    const client = mockClient();
    const delta: DeltaContent = {
      topic: 'work',
      content: '## New Work activity',
      requiresApproval: false,
    };
    const opts: DeltaWriteOptions = {
      scanRange: { start: '2026-01-01', end: '2026-01-15' },
      sourceCounts: { gmail: 10, calendar: 0 },
    };

    await writeDeltaToDrive(client, testFolderMap, delta, opts);
    expect(client.driveWrite).toHaveBeenCalledWith('delta-2026-01-15.md', expect.any(String), 'text', 'work-id');
  });
});
