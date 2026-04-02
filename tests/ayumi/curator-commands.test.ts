import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCuratorCommand } from '../../src/ayumi/curator-commands.js';
import type { BrokerClient } from '../../src/broker-client.js';

// Mock broker-client module
const mockDriveWrite = vi.fn().mockResolvedValue({ file_id: 'new-id', name: 'test', mime_type: 'text/plain', web_view_link: null });
const mockDriveList = vi.fn();
const mockDriveRead = vi.fn();
const mockDriveSearch = vi.fn();
const mockDriveCreateFolder = vi.fn();

vi.mock('../../src/broker-client.js', () => ({
  createBrokerClientFromEnv: () => ({
    health: vi.fn(),
    gmailSearch: vi.fn(),
    gmailMessages: vi.fn(),
    calendarEvents: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
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
      // Should write summary.md to finance folder
      expect(mockDriveWrite).toHaveBeenCalledWith(
        'summary.md',
        sampleManifest.topics.finance.summaryContent,
        'text',
        'finance-id',
      );
      // Should update manifest (removing finance, keeping health)
      expect(mockDriveWrite).toHaveBeenCalledWith(
        'pending-review.json',
        expect.stringContaining('"health"'),
        'text',
        'meta-id',
      );
    });

    it('approves all topics', async () => {
      setupManifestInDrive(sampleManifest);
      const result = await handleCuratorCommand('!curator approve all');

      expect(result).toContain('**finance** — approved');
      expect(result).toContain('**health** — approved');
      // Should write both summaries
      expect(mockDriveWrite).toHaveBeenCalledWith('summary.md', sampleManifest.topics.finance.summaryContent, 'text', 'finance-id');
      expect(mockDriveWrite).toHaveBeenCalledWith('summary.md', sampleManifest.topics.health.summaryContent, 'text', 'health-id');
      // Manifest should be cleared (empty)
      expect(mockDriveWrite).toHaveBeenCalledWith('pending-review.json', '{}', 'text', 'meta-id');
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
      // Should update manifest without finance
      expect(mockDriveWrite).toHaveBeenCalledWith(
        'pending-review.json',
        expect.stringContaining('"health"'),
        'text',
        'meta-id',
      );
    });

    it('reports unknown topic', async () => {
      setupManifestInDrive(null);
      const result = await handleCuratorCommand('!curator reject travel');
      expect(result).toContain('not found in pending manifest');
    });
  });
});
