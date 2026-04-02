import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadLifeContext, _resetForTest, DEFAULT_TOPIC_SIZE_BUDGET } from '../../src/ayumi/life-context-loader.js';
import type { BrokerClient, DriveFile, DriveListResult, DriveReadResult, DriveSearchResult } from '../../src/broker-client.js';

// Track the mock client so tests can configure per-call behavior
let mockClient: BrokerClient;

vi.mock('../../src/broker-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/broker-client.js')>('../../src/broker-client.js');
  return {
    ...actual,
    createBrokerClient: () => mockClient,
  };
});

function makeDriveFile(name: string, modified_at: string): DriveFile {
  return {
    file_id: `id-${name}`,
    name,
    mime_type: 'text/plain',
    size_bytes: 100,
    modified_at,
    web_view_link: null,
  };
}

function makeFolderFile(name: string): DriveFile {
  return {
    file_id: `folder-${name}`,
    name,
    mime_type: 'application/vnd.google-apps.folder',
    size_bytes: null,
    modified_at: '2026-01-01T00:00:00Z',
    web_view_link: null,
  };
}

beforeEach(() => {
  _resetForTest();
  // Set env vars for broker client creation
  process.env.BROKER_URL = 'http://localhost:9999';
  process.env.BROKER_API_SECRET = 'test-secret';
  process.env.BROKER_TENANT_ID = 'test-tenant';
  process.env.BROKER_ACTOR_ID = 'test-actor';

  mockClient = {
    health: vi.fn(),
    gmailSearch: vi.fn(),
    gmailMessages: vi.fn(),
    calendarEvents: vi.fn(),
    driveRead: vi.fn(),
    driveWrite: vi.fn(),
    driveSearch: vi.fn(),
    driveCreateFolder: vi.fn(),
    driveList: vi.fn(),
  };
});

function setupDriveFolders(topicFiles: DriveFile[]) {
  // driveSearch finds life-context folder
  (mockClient.driveSearch as ReturnType<typeof vi.fn>).mockResolvedValue({
    files: [makeFolderFile('life-context')],
  } satisfies DriveSearchResult);

  // driveList for life-context/ returns topic subfolders
  const listMock = mockClient.driveList as ReturnType<typeof vi.fn>;
  listMock.mockImplementation((folderId: string) => {
    if (folderId === 'folder-life-context') {
      return Promise.resolve({
        files: [makeFolderFile('work'), makeFolderFile('travel'), makeFolderFile('social'), makeFolderFile('hobbies')],
      } satisfies DriveListResult);
    }
    // Topic folder listing
    return Promise.resolve({ files: topicFiles } satisfies DriveListResult);
  });
}

describe('loadLifeContext', () => {
  it('returns null for non-life-context agents', async () => {
    const result = await loadLifeContext('curator');
    expect(result).toBeNull();
  });

  it('returns null when env vars are missing', async () => {
    delete process.env.BROKER_URL;
    _resetForTest();
    const result = await loadLifeContext('life-work');
    expect(result).toBeNull();
  });

  it('returns null for empty folder', async () => {
    setupDriveFolders([]);
    const result = await loadLifeContext('life-work');
    expect(result).toBeNull();
  });

  it('returns null when folder has no .md files', async () => {
    setupDriveFolders([
      { ...makeDriveFile('data.json', '2026-03-01T00:00:00Z'), name: 'data.json' },
    ]);
    const result = await loadLifeContext('life-work');
    expect(result).toBeNull();
  });

  it('loads a single .md file', async () => {
    setupDriveFolders([
      makeDriveFile('summary.md', '2026-03-15T00:00:00Z'),
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'summary.md',
      mime_type: 'text/plain',
      content: '# Work Summary\n\nKey project updates.',
    } satisfies DriveReadResult);

    const result = await loadLifeContext('life-work');
    expect(result).toContain('--- LIFE CONTEXT DATA ---');
    expect(result).toContain('## summary.md');
    expect(result).toContain('Key project updates.');
    expect(result).toContain('--- END LIFE CONTEXT DATA ---');
  });

  it('loads multiple .md files sorted by modified date (newest first)', async () => {
    setupDriveFolders([
      makeDriveFile('entities.md', '2026-03-01T00:00:00Z'),
      makeDriveFile('summary.md', '2026-03-15T00:00:00Z'),
      makeDriveFile('timeline.md', '2026-03-10T00:00:00Z'),
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockImplementation((fileId: string) => {
      const contentMap: Record<string, string> = {
        'id-summary.md': '# Summary\nNewest content',
        'id-timeline.md': '# Timeline\nMiddle content',
        'id-entities.md': '# Entities\nOldest content',
      };
      return Promise.resolve({
        name: fileId.replace('id-', ''),
        mime_type: 'text/plain',
        content: contentMap[fileId] ?? '',
      } satisfies DriveReadResult);
    });

    const result = await loadLifeContext('life-work');
    expect(result).not.toBeNull();

    // Verify ordering: summary (newest) before timeline before entities (oldest)
    const summaryIdx = result!.indexOf('## summary.md');
    const timelineIdx = result!.indexOf('## timeline.md');
    const entitiesIdx = result!.indexOf('## entities.md');
    expect(summaryIdx).toBeLessThan(timelineIdx);
    expect(timelineIdx).toBeLessThan(entitiesIdx);
  });

  it('backward compatible: existing 3-file folders produce same sections', async () => {
    setupDriveFolders([
      makeDriveFile('summary.md', '2026-03-15T00:00:00Z'),
      makeDriveFile('timeline.md', '2026-03-14T00:00:00Z'),
      makeDriveFile('entities.md', '2026-03-13T00:00:00Z'),
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockImplementation((fileId: string) => {
      const contentMap: Record<string, string> = {
        'id-summary.md': '# Work — Summary\n\nProject updates.',
        'id-timeline.md': '# Work — Timeline\n\n- 2026-03-15 Meeting',
        'id-entities.md': '# Work — Entities\n\n## People\n- Alice',
      };
      return Promise.resolve({
        name: fileId.replace('id-', ''),
        mime_type: 'text/plain',
        content: contentMap[fileId] ?? '',
      } satisfies DriveReadResult);
    });

    const result = await loadLifeContext('life-work');
    expect(result).toContain('## summary.md');
    expect(result).toContain('## timeline.md');
    expect(result).toContain('## entities.md');
    expect(result).toContain('Project updates.');
    expect(result).toContain('Meeting');
    expect(result).toContain('Alice');
  });

  it('reads all .md files, not just hardcoded names', async () => {
    setupDriveFolders([
      makeDriveFile('summary.md', '2026-03-15T00:00:00Z'),
      makeDriveFile('weekly-report.md', '2026-03-14T00:00:00Z'),
      makeDriveFile('notes.md', '2026-03-13T00:00:00Z'),
      { ...makeDriveFile('data.json', '2026-03-16T00:00:00Z'), name: 'data.json' },
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockImplementation((fileId: string) => {
      return Promise.resolve({
        name: fileId.replace('id-', ''),
        mime_type: 'text/plain',
        content: `Content of ${fileId}`,
      } satisfies DriveReadResult);
    });

    const result = await loadLifeContext('life-work');
    expect(result).toContain('## summary.md');
    expect(result).toContain('## weekly-report.md');
    expect(result).toContain('## notes.md');
    // Should NOT include non-.md files
    expect(result).not.toContain('data.json');
  });

  it('truncates oldest files when over size budget', async () => {
    // Create files where each is ~100 bytes of content
    const largeContent = 'x'.repeat(100);
    setupDriveFolders([
      makeDriveFile('newest.md', '2026-03-15T00:00:00Z'),
      makeDriveFile('middle.md', '2026-03-10T00:00:00Z'),
      makeDriveFile('oldest.md', '2026-03-05T00:00:00Z'),
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockImplementation((fileId: string) => {
      return Promise.resolve({
        name: fileId.replace('id-', ''),
        mime_type: 'text/plain',
        content: largeContent,
      } satisfies DriveReadResult);
    });

    // Set budget to fit ~2 files (each section is "## name\n" + content ≈ 115 bytes)
    const result = await loadLifeContext('life-work', 250);
    expect(result).toContain('## newest.md');
    expect(result).toContain('## middle.md');
    expect(result).not.toContain('## oldest.md');
    expect(result).toContain('[truncated: 1 file omitted due to size budget]');
  });

  it('truncates multiple files with correct count', async () => {
    const largeContent = 'x'.repeat(200);
    setupDriveFolders([
      makeDriveFile('file1.md', '2026-03-15T00:00:00Z'),
      makeDriveFile('file2.md', '2026-03-10T00:00:00Z'),
      makeDriveFile('file3.md', '2026-03-05T00:00:00Z'),
      makeDriveFile('file4.md', '2026-03-01T00:00:00Z'),
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockImplementation((fileId: string) => {
      return Promise.resolve({
        name: fileId.replace('id-', ''),
        mime_type: 'text/plain',
        content: largeContent,
      } satisfies DriveReadResult);
    });

    // Budget fits only ~1 file
    const result = await loadLifeContext('life-work', 250);
    expect(result).toContain('## file1.md');
    expect(result).not.toContain('## file2.md');
    expect(result).toContain('[truncated: 3 files omitted due to size budget]');
  });

  it('always includes at least the first file even if over budget', async () => {
    const largeContent = 'x'.repeat(1000);
    setupDriveFolders([
      makeDriveFile('big.md', '2026-03-15T00:00:00Z'),
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'big.md',
      mime_type: 'text/plain',
      content: largeContent,
    } satisfies DriveReadResult);

    // Budget is tiny but we should still get the first file
    const result = await loadLifeContext('life-work', 10);
    expect(result).toContain('## big.md');
    expect(result).not.toContain('[truncated');
  });

  it('works for different agent names', async () => {
    setupDriveFolders([
      makeDriveFile('summary.md', '2026-03-15T00:00:00Z'),
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'summary.md',
      mime_type: 'text/plain',
      content: '# Travel\nTrip plans.',
    } satisfies DriveReadResult);

    const result = await loadLifeContext('life-travel');
    expect(result).toContain('Trip plans.');
  });
});
