import { describe, it, expect, vi } from 'vitest';
import { writeTopicToDrive, type DriveWriterOptions } from '../../src/ayumi/drive-writer.js';
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

  it('skips write for tier 3 topics when not approved', async () => {
    const client = mockClient();
    const summary: TopicSummaryResult = {
      topic: 'health',
      files: { summary: '# Health — Summary\n\n...' },
      requiresApproval: true,
      itemCount: 2,
    };

    const result = await writeTopicToDrive(client, testFolderMap, summary, { approved: false });

    expect(result.written).toBe(false);
    expect(result.skippedReason).toBe('approval_required');
    expect(client.driveWrite).not.toHaveBeenCalled();
  });

  it('defaults to not approved for tier 3 topics', async () => {
    const client = mockClient();
    const summary: TopicSummaryResult = {
      topic: 'health',
      files: { summary: '# Health — Summary\n\n...' },
      requiresApproval: true,
      itemCount: 2,
    };

    const result = await writeTopicToDrive(client, testFolderMap, summary);

    expect(result.written).toBe(false);
  });
});
