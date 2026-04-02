import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCuratorCommand } from '../../src/ayumi/curator-commands.js';
import type { BrokerClient } from '../../src/broker-client.js';

// Mock broker-client module
const mockDriveWrite = vi.fn().mockResolvedValue({ file_id: 'new-id', name: 'test', mime_type: 'text/plain', web_view_link: null });
const mockDriveList = vi.fn();
const mockDriveRead = vi.fn();
const mockDriveSearch = vi.fn();
const mockDriveCreateFolder = vi.fn();
const mockGmailSearch = vi.fn().mockResolvedValue({ messages: [] });
const mockGmailMessages = vi.fn().mockResolvedValue({ messages: [] });
const mockCalendarEvents = vi.fn().mockResolvedValue({ events: [] });

vi.mock('../../src/broker-client.js', () => ({
  createBrokerClientFromEnv: () => ({
    health: vi.fn(),
    gmailSearch: mockGmailSearch,
    gmailMessages: mockGmailMessages,
    calendarEvents: mockCalendarEvents,
    driveRead: mockDriveRead,
    driveWrite: mockDriveWrite,
    driveSearch: mockDriveSearch,
    driveCreateFolder: mockDriveCreateFolder,
    driveList: mockDriveList,
  }),
}));

// Mock life-context-setup to return a fixed folder map
vi.mock('../../src/ayumi/life-context-setup.js', () => ({
  TOPIC_FOLDERS: ['work', 'travel', 'finance', 'health', 'social', 'hobbies'],
  ensureLifeContextFolders: vi.fn().mockResolvedValue({
    root: 'root-id',
    topics: { work: 'work-id', travel: 'travel-id', finance: 'finance-id', health: 'health-id', social: 'social-id', hobbies: 'hobbies-id' },
    meta: 'meta-id',
  }),
}));

// Mock exclusions
vi.mock('../../src/ayumi/exclusions.js', () => ({
  loadExclusions: () => ({ emails: [], domains: [], labels: [] }),
  shouldExclude: () => false,
}));

const sampleManifest = {
  createdAt: '2026-04-01T10:00:00.000Z',
  topics: {
    finance: {
      fileCount: 1,
      totalSize: 150,
      preview: '# Finance — Summary\n\n3 item(s) found in this sensitive category.',
      summaryContent: '# Finance — Summary\n\n3 item(s) found in this sensitive category.\n\nThis is a high-sensitivity topic (tier 3). Only aggregate counts are included.\n\n- 2 email(s), 1 calendar event(s)\n- Date range: 2026-03-01 to 2026-03-28\n',
    },
    health: {
      fileCount: 1,
      totalSize: 120,
      preview: '# Health — Summary\n\n2 item(s) found in this sensitive category.',
      summaryContent: '# Health — Summary\n\n2 item(s) found in this sensitive category.\n\nThis is a high-sensitivity topic (tier 3). Only aggregate counts are included.\n\n- 1 email(s), 1 calendar event(s)\n- Date range: 2026-03-05 to 2026-03-20\n',
    },
  },
};

const sampleScanState = {
  last_seed: '2026-04-02T00:00:00Z',
  topics: {
    work: { last_scan: '2026-04-07T00:00:00Z', gmail_after: '2026-04-07', pending_deltas: 1 },
    travel: { last_scan: '2026-04-07T00:00:00Z', gmail_after: '2026-04-07', pending_deltas: 0 },
    finance: { last_scan: '2026-04-07T00:00:00Z', gmail_after: '2026-04-07', pending_deltas: 0 },
    health: { last_scan: '2026-04-07T00:00:00Z', gmail_after: '2026-04-07', pending_deltas: 0 },
    social: { last_scan: '2026-04-07T00:00:00Z', gmail_after: '2026-04-07', pending_deltas: 0 },
    hobbies: { last_scan: '2026-04-07T00:00:00Z', gmail_after: '2026-04-07', pending_deltas: 0 },
  },
  next_compaction: '2026-05-02',
};

function setupManifestInDrive(manifest: object | null) {
  if (manifest) {
    mockDriveList.mockResolvedValue({
      files: [{ file_id: 'manifest-id', name: 'pending-review.json', mime_type: 'text/plain', size_bytes: 100, modified_at: '2026-04-01T10:00:00Z', web_view_link: null }],
    });
    mockDriveRead.mockResolvedValue({
      name: 'pending-review.json',
      mime_type: 'text/plain',
      content: JSON.stringify(manifest),
    });
  } else {
    mockDriveList.mockResolvedValue({ files: [] });
  }
}

function setupScanStateInDrive(state: object | null) {
  if (state) {
    mockDriveList.mockImplementation((_folderId: string, query?: string) => {
      // Return scan-state.json when listing meta folder
      if (query === 'scan-state.json') {
        return Promise.resolve({
          files: [{ file_id: 'state-id', name: 'scan-state.json', mime_type: 'text/plain', size_bytes: 200, modified_at: '2026-04-07T00:00:00Z', web_view_link: null }],
        });
      }
      // Return manifest query
      return Promise.resolve({ files: [] });
    });
    mockDriveRead.mockImplementation((fileId: string) => {
      if (fileId === 'state-id') {
        return Promise.resolve({
          name: 'scan-state.json',
          mime_type: 'text/plain',
          content: JSON.stringify(state),
        });
      }
      return Promise.resolve({ name: 'unknown', mime_type: 'text/plain', content: '{}' });
    });
  } else {
    mockDriveList.mockResolvedValue({ files: [] });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset defaults
  mockGmailSearch.mockResolvedValue({ messages: [] });
  mockGmailMessages.mockResolvedValue({ messages: [] });
  mockCalendarEvents.mockResolvedValue({ events: [] });
});

describe('handleCuratorCommand', () => {
  it('returns null for non-curator commands', async () => {
    const result = await handleCuratorCommand('!help');
    expect(result).toBeNull();
  });

  it('returns error for unknown subcommand', async () => {
    setupManifestInDrive(null);
    const result = await handleCuratorCommand('!curator foobar');
    expect(result).toContain('Unknown curator command');
  });

  // ----- Approval commands (existing) -----

  describe('!curator pending', () => {
    it('reports no pending topics when manifest is empty', async () => {
      setupManifestInDrive(null);
      const result = await handleCuratorCommand('!curator pending');
      expect(result).toContain('No pending tier-3 topics');
    });

    it('reports no pending topics when manifest has empty topics', async () => {
      setupManifestInDrive({ createdAt: '2026-04-01T10:00:00Z', topics: {} });
      const result = await handleCuratorCommand('!curator pending');
      expect(result).toContain('No pending tier-3 topics');
    });

    it('lists pending topics with previews', async () => {
      setupManifestInDrive(sampleManifest);
      const result = await handleCuratorCommand('!curator pending');
      expect(result).toContain('**finance**');
      expect(result).toContain('**health**');
      expect(result).toContain('1 file(s)');
      expect(result).toContain('!curator approve');
    });
  });

  describe('!curator approve', () => {
    it('returns usage when no topic given', async () => {
      const result = await handleCuratorCommand('!curator approve');
      expect(result).toContain('Usage');
    });

    it('reports nothing to approve when manifest is empty', async () => {
      setupManifestInDrive(null);
      const result = await handleCuratorCommand('!curator approve finance');
      expect(result).toContain('No pending topics to approve');
    });

    it('approves a single topic and writes to Drive', async () => {
      setupManifestInDrive(sampleManifest);
      const result = await handleCuratorCommand('!curator approve finance');

      expect(result).toContain('**finance** — approved');
      expect(mockDriveWrite).toHaveBeenCalledWith(
        'summary.md',
        sampleManifest.topics.finance.summaryContent,
        'text',
        'finance-id',
      );
    });

    it('approves all topics', async () => {
      setupManifestInDrive(sampleManifest);
      const result = await handleCuratorCommand('!curator approve all');

      expect(result).toContain('**finance** — approved');
      expect(result).toContain('**health** — approved');
    });

    it('reports unknown topic gracefully', async () => {
      setupManifestInDrive(sampleManifest);
      const result = await handleCuratorCommand('!curator approve travel');
      expect(result).toContain('not found in pending manifest');
    });
  });

  describe('!curator reject', () => {
    it('returns usage when no topic given', async () => {
      const result = await handleCuratorCommand('!curator reject');
      expect(result).toContain('Usage');
    });

    it('rejects a topic and removes from manifest', async () => {
      setupManifestInDrive(sampleManifest);
      const result = await handleCuratorCommand('!curator reject finance');
      expect(result).toContain('**finance** — rejected');
    });

    it('reports unknown topic', async () => {
      setupManifestInDrive(null);
      const result = await handleCuratorCommand('!curator reject travel');
      expect(result).toContain('not found in pending manifest');
    });
  });

  // ----- Sync / Seed / Status commands -----

  describe('!curator status', () => {
    it('reports no scan state when uninitialized', async () => {
      setupScanStateInDrive(null);
      const result = await handleCuratorCommand('!curator status');
      expect(result).toContain('No scan state found');
    });

    it('displays scan state summary', async () => {
      setupScanStateInDrive(sampleScanState);
      const result = await handleCuratorCommand('!curator status');

      expect(result).toContain('Last seed: 2026-04-02');
      expect(result).toContain('Next compaction: 2026-05-02');
      expect(result).toContain('**work**');
      expect(result).toContain('watermark: 2026-04-07');
      expect(result).toContain('pending deltas: 1');
    });
  });

  describe('!curator seed', () => {
    it('returns usage when no dates given', async () => {
      const result = await handleCuratorCommand('!curator seed');
      expect(result).toContain('Usage');
    });

    it('returns usage when only one date given', async () => {
      setupManifestInDrive(null);
      const result = await handleCuratorCommand('!curator seed 2026-03-01');
      expect(result).toContain('Usage');
    });

    it('validates date format', async () => {
      setupManifestInDrive(null);
      const result = await handleCuratorCommand('!curator seed march 2026');
      expect(result).toContain('Invalid date format');
    });

    it('runs seed extraction and initializes scan state', async () => {
      setupScanStateInDrive(null);
      // Mock extraction returning some work items
      mockGmailSearch.mockResolvedValue({
        messages: [
          { id: 'msg1', threadId: 't1', from: 'alice@work.com', to: 'me@me.com', subject: 'Project update', snippet: 'Latest status', date: '2026-03-15T10:00:00Z', labelIds: [], hasAttachments: false },
        ],
      });
      mockGmailMessages.mockResolvedValue({
        messages: [
          { id: 'msg1', threadId: 't1', from: 'alice@work.com', to: 'me@me.com', subject: 'Project update', snippet: 'Latest status', date: '2026-03-15T10:00:00Z', labelIds: [], hasAttachments: false, body: 'Full body', bodyHtml: '<p>Full body</p>' },
        ],
      });
      mockCalendarEvents.mockResolvedValue({ events: [] });

      const result = await handleCuratorCommand('!curator seed 2026-03-01 2026-04-01');

      expect(result).toContain('Seed run: 2026-03-01 to 2026-04-01');
      expect(result).toContain('Total items extracted: 1');
      expect(result).toContain('Scan state initialized');
      // Should write scan-state.json
      expect(mockDriveWrite).toHaveBeenCalledWith(
        'scan-state.json',
        expect.stringContaining('"last_seed"'),
        'text',
        'meta-id',
      );
    });
  });

  describe('!curator sync', () => {
    it('requires seed before sync', async () => {
      setupScanStateInDrive(null);
      const result = await handleCuratorCommand('!curator sync');
      expect(result).toContain('No seed run found');
    });

    it('runs incremental sync and updates scan state', async () => {
      setupScanStateInDrive(sampleScanState);
      // Mock extraction returning a travel item
      mockGmailSearch.mockResolvedValue({
        messages: [
          { id: 'msg2', threadId: 't2', from: 'hotels@booking.com', to: 'me@me.com', subject: 'Hotel booking confirmation', snippet: 'Your trip is booked', date: '2026-04-10T10:00:00Z', labelIds: [], hasAttachments: false },
        ],
      });
      mockGmailMessages.mockResolvedValue({
        messages: [
          { id: 'msg2', threadId: 't2', from: 'hotels@booking.com', to: 'me@me.com', subject: 'Hotel booking confirmation', snippet: 'Your trip is booked', date: '2026-04-10T10:00:00Z', labelIds: [], hasAttachments: false, body: 'Booking details', bodyHtml: '<p>Booking details</p>' },
        ],
      });
      mockCalendarEvents.mockResolvedValue({ events: [] });

      const result = await handleCuratorCommand('!curator sync');

      expect(result).toContain('Sync results');
      expect(result).toContain('Scan state updated');
      // Should write scan-state.json
      expect(mockDriveWrite).toHaveBeenCalledWith(
        'scan-state.json',
        expect.stringContaining('"last_scan"'),
        'text',
        'meta-id',
      );
    });

    it('reports no new items when extraction is empty', async () => {
      setupScanStateInDrive(sampleScanState);
      mockGmailSearch.mockResolvedValue({ messages: [] });
      mockCalendarEvents.mockResolvedValue({ events: [] });

      const result = await handleCuratorCommand('!curator sync');

      expect(result).toContain('no new items');
      expect(result).toContain('Scan state updated');
    });
  });
});
