import { describe, it, expect, vi } from 'vitest';
import { extractAndClassify, type ClassifiedItem, type ExtractionOptions } from '../../src/ayumi/extraction-pipeline.js';
import type { BrokerClient, GmailMessage, CalendarEvent } from '../../src/broker-client.js';
import type { ExclusionConfig } from '../../src/ayumi/exclusions.js';

function mockBrokerClient(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    health: vi.fn().mockResolvedValue({ ok: true }),
    gmailSearch: vi.fn().mockResolvedValue({ messages: [] }),
    gmailMessages: vi.fn().mockResolvedValue({ messages: [] }),
    calendarEvents: vi.fn().mockResolvedValue({ events: [] }),
    driveRead: vi.fn(),
    driveWrite: vi.fn(),
    driveSearch: vi.fn(),
    driveCreateFolder: vi.fn(),
    driveList: vi.fn(),
    ...overrides,
  };
}

const emptyExclusions: ExclusionConfig = { emails: [], domains: [], labels: [] };

describe('extractAndClassify', () => {
  it('fetches Gmail messages in batches and returns classified items', async () => {
    const messages: GmailMessage[] = [
      { id: 'msg1', threadId: 't1', from: 'boss@work.com', to: 'me@example.com', subject: 'Q4 Review', snippet: 'Please review the Q4 report', date: '2026-01-15T10:00:00Z', labelIds: ['INBOX'], hasAttachments: false },
      { id: 'msg2', threadId: 't2', from: 'hotel@booking.com', to: 'me@example.com', subject: 'Reservation Confirmed', snippet: 'Your hotel in Tokyo is booked', date: '2026-01-20T14:00:00Z', labelIds: ['INBOX'], hasAttachments: false },
    ];

    const client = mockBrokerClient({
      gmailSearch: vi.fn().mockResolvedValue({ messages, nextPageToken: undefined }),
      gmailMessages: vi.fn().mockResolvedValue({
        messages: messages.map((m) => ({ ...m, body: 'full body', bodyHtml: '<p>full body</p>' })),
      }),
    });

    const result = await extractAndClassify(client, emptyExclusions, {
      timeMin: '2026-01-01T00:00:00Z',
      timeMax: '2026-01-31T23:59:59Z',
    });

    expect(result.length).toBe(2);
    expect(result.every((r) => r.topic !== undefined)).toBe(true);
    expect(result.every((r) => r.tier >= 1 && r.tier <= 3)).toBe(true);
  });

  it('fetches calendar events and classifies them', async () => {
    const events: CalendarEvent[] = [
      { id: 'evt1', title: 'Team Standup', description: 'Daily sync', start_at: '2026-01-15T09:00:00Z', end_at: '2026-01-15T09:30:00Z', all_day: false, location: null, organizer_email: 'boss@work.com', status: 'confirmed' },
    ];

    const client = mockBrokerClient({
      gmailSearch: vi.fn().mockResolvedValue({ messages: [] }),
      calendarEvents: vi.fn().mockResolvedValue({ events }),
    });

    const result = await extractAndClassify(client, emptyExclusions, {
      timeMin: '2026-01-01T00:00:00Z',
      timeMax: '2026-01-31T23:59:59Z',
    });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe('calendar');
  });

  it('excludes messages matching exclusion config', async () => {
    const messages: GmailMessage[] = [
      { id: 'msg1', threadId: 't1', from: 'boss@work.com', to: 'me@example.com', subject: 'Real', snippet: 'real', date: '2026-01-15T10:00:00Z', labelIds: ['INBOX'], hasAttachments: false },
      { id: 'msg2', threadId: 't2', from: 'noreply@spam.com', to: 'me@example.com', subject: 'Spam', snippet: 'spam', date: '2026-01-15T10:00:00Z', labelIds: ['SPAM'], hasAttachments: false },
    ];

    const exclusions: ExclusionConfig = { emails: ['noreply@spam.com'], domains: [], labels: [] };

    const client = mockBrokerClient({
      gmailSearch: vi.fn().mockResolvedValue({ messages, nextPageToken: undefined }),
      gmailMessages: vi.fn().mockResolvedValue({
        messages: messages.map((m) => ({ ...m, body: 'body', bodyHtml: '<p>body</p>' })),
      }),
    });

    const result = await extractAndClassify(client, exclusions, {
      timeMin: '2026-01-01T00:00:00Z',
      timeMax: '2026-01-31T23:59:59Z',
    });

    expect(result.length).toBe(1);
    expect(result[0].sourceId).toBe('msg1');
  });

  it('paginates Gmail search results', async () => {
    const page1: GmailMessage[] = [
      { id: 'msg1', threadId: 't1', from: 'a@work.com', to: 'me@example.com', subject: 'A', snippet: 'a', date: '2026-01-15T10:00:00Z', labelIds: ['INBOX'], hasAttachments: false },
    ];
    const page2: GmailMessage[] = [
      { id: 'msg2', threadId: 't2', from: 'b@work.com', to: 'me@example.com', subject: 'B', snippet: 'b', date: '2026-01-16T10:00:00Z', labelIds: ['INBOX'], hasAttachments: false },
    ];

    const client = mockBrokerClient({
      gmailSearch: vi.fn()
        .mockResolvedValueOnce({ messages: page1, nextPageToken: 'page2' })
        .mockResolvedValueOnce({ messages: page2, nextPageToken: undefined }),
      gmailMessages: vi.fn().mockResolvedValue({
        messages: [
          { ...page1[0], body: 'body', bodyHtml: '<p>body</p>' },
          { ...page2[0], body: 'body', bodyHtml: '<p>body</p>' },
        ],
      }),
    });

    const result = await extractAndClassify(client, emptyExclusions, {
      timeMin: '2026-01-01T00:00:00Z',
      timeMax: '2026-01-31T23:59:59Z',
    });

    expect(client.gmailSearch).toHaveBeenCalledTimes(2);
    expect(result.length).toBe(2);
  });
});
