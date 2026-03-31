import { describe, it, expect, vi } from 'vitest';
import { extractAndClassify } from '../../src/ayumi/extraction-pipeline.js';
import { summarizeTopic } from '../../src/ayumi/topic-summarizer.js';
import { writeTopicToDrive } from '../../src/ayumi/drive-writer.js';
import type { BrokerClient } from '../../src/broker-client.js';
import type { FolderMap, TopicName } from '../../src/life-context-setup.js';

function mockClient(): BrokerClient {
  return {
    health: vi.fn().mockResolvedValue({ ok: true }),
    gmailSearch: vi.fn().mockResolvedValue({
      messages: [
        { id: 'msg1', threadId: 't1', from: 'boss@work.com', to: 'me@example.com', subject: 'Sprint Planning', snippet: 'Lets plan the next sprint', date: '2026-01-15T10:00:00Z', labelIds: ['INBOX'], hasAttachments: false },
        { id: 'msg2', threadId: 't2', from: 'hotel@booking.com', to: 'me@example.com', subject: 'Hotel Booking Confirmed', snippet: 'Your booking at Hilton is confirmed', date: '2026-01-20T14:00:00Z', labelIds: ['INBOX'], hasAttachments: false },
        { id: 'msg3', threadId: 't3', from: 'bank@finance.com', to: 'me@example.com', subject: 'Monthly Invoice Statement', snippet: 'Your statement is ready', date: '2026-01-25T08:00:00Z', labelIds: ['INBOX'], hasAttachments: false },
      ],
      nextPageToken: undefined,
    }),
    gmailMessages: vi.fn().mockResolvedValue({
      messages: [
        { id: 'msg1', threadId: 't1', from: 'boss@work.com', to: 'me@example.com', subject: 'Sprint Planning', snippet: 'Lets plan the next sprint', date: '2026-01-15T10:00:00Z', labelIds: ['INBOX'], hasAttachments: false, body: 'Full sprint planning details', bodyHtml: '' },
        { id: 'msg2', threadId: 't2', from: 'hotel@booking.com', to: 'me@example.com', subject: 'Hotel Booking Confirmed', snippet: 'Your booking at Hilton is confirmed', date: '2026-01-20T14:00:00Z', labelIds: ['INBOX'], hasAttachments: false, body: 'Booking details', bodyHtml: '' },
        { id: 'msg3', threadId: 't3', from: 'bank@finance.com', to: 'me@example.com', subject: 'Monthly Invoice Statement', snippet: 'Your statement is ready', date: '2026-01-25T08:00:00Z', labelIds: ['INBOX'], hasAttachments: false, body: 'Statement details', bodyHtml: '' },
      ],
    }),
    calendarEvents: vi.fn().mockResolvedValue({ events: [] }),
    driveRead: vi.fn(),
    driveWrite: vi.fn().mockResolvedValue({ file_id: 'f1', name: 'summary.md', mime_type: 'text/plain', web_view_link: null }),
    driveSearch: vi.fn(),
    driveCreateFolder: vi.fn(),
    driveList: vi.fn(),
  };
}

const folderMap: FolderMap = {
  root: 'root-id',
  topics: { work: 'work-id', travel: 'travel-id', finance: 'finance-id', health: 'health-id', social: 'social-id', hobbies: 'hobbies-id' },
  meta: 'meta-id',
};

describe('extraction pipeline integration', () => {
  it('full pipeline: extract → classify → summarize → write', async () => {
    const client = mockClient();
    const exclusions = { emails: [], domains: [], labels: [] };

    // Step 1: Extract and classify
    const classified = await extractAndClassify(client, exclusions, {
      timeMin: '2026-01-01T00:00:00Z',
      timeMax: '2026-01-31T23:59:59Z',
    });

    expect(classified.length).toBe(3);

    // Step 2: Group by topic
    const byTopic = new Map<TopicName, typeof classified>();
    for (const item of classified) {
      const existing = byTopic.get(item.topic) ?? [];
      existing.push(item);
      byTopic.set(item.topic, existing);
    }

    // Step 3: Summarize each topic
    const summaries = [...byTopic.entries()].map(([topic, items]) =>
      summarizeTopic(topic, items),
    );

    expect(summaries.length).toBeGreaterThan(0);

    // Step 4: Write to Drive (approve tier 3)
    const writeResults = await Promise.all(
      summaries.map((s) => writeTopicToDrive(client, folderMap, s, { approved: true })),
    );

    expect(writeResults.every((r) => r.written)).toBe(true);
    // At least summary.md written for each topic
    expect((client.driveWrite as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(summaries.length);
  });
});
