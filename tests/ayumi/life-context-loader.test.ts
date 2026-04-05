import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadLifeContext, _resetForTest, DEFAULT_TOPIC_SIZE_BUDGET } from '../../src/ayumi/life-context-loader.js';
import type { BrokerClient, DriveFile, DriveListResult, DriveReadResult, DriveSearchResult } from '../../src/broker-client.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

let tempDir: string;

beforeEach(async () => {
  _resetForTest();
  tempDir = await mkdtemp(join(tmpdir(), 'loader-test-'));

  // Clear VAULT_PATH so tests can set it explicitly
  delete process.env.VAULT_PATH;

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

afterEach(async () => {
  delete process.env.VAULT_PATH;
  await rm(tempDir, { recursive: true, force: true });
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

async function setupVaultTopic(topic: string, files: Record<string, string>, sensitive = false) {
  const dir = sensitive
    ? join(tempDir, 'topics', '_sensitive', topic)
    : join(tempDir, 'topics', topic);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
}

// ---- Vault (local filesystem) tests ----

describe('loadLifeContext — vault path', () => {
  it('returns null for non-life-context agents', async () => {
    process.env.VAULT_PATH = tempDir;
    const result = await loadLifeContext('life-curator');
    expect(result).toBeNull();
  });

  it('loads files from local vault when VAULT_PATH is set', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('work', {
      'summary.md': '---\ntier: 2\n---\n# Work Summary\n\nProject updates.',
      'timeline.md': '---\ntier: 2\n---\n# Timeline\n\n- 2026-03-15 Meeting',
    });

    const result = await loadLifeContext('life-work');

    expect(result).toContain('--- LIFE CONTEXT DATA ---');
    expect(result).toContain('## summary.md');
    expect(result).toContain('Project updates.');
    expect(result).toContain('## timeline.md');
    expect(result).toContain('Meeting');
    expect(result).toContain('--- END LIFE CONTEXT DATA ---');
  });

  it('strips frontmatter from vault files', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('work', {
      'summary.md': '---\ntier: 2\ntopic: work\ntype: summary\n---\n# Work Summary\n\nContent.',
    });

    const result = await loadLifeContext('life-work');

    expect(result).not.toContain('tier: 2');
    expect(result).toContain('# Work Summary');
    expect(result).toContain('Content.');
  });

  it('skips missing files gracefully', async () => {
    process.env.VAULT_PATH = tempDir;
    // Only summary.md exists — timeline.md and entities.md are missing
    await setupVaultTopic('work', {
      'summary.md': '# Work\n\nJust a summary.',
    });

    const result = await loadLifeContext('life-work');

    expect(result).toContain('Just a summary.');
    expect(result).not.toContain('## timeline.md');
    expect(result).not.toContain('## entities.md');
  });

  it('returns null when topic directory does not exist', async () => {
    process.env.VAULT_PATH = tempDir;
    // No files created
    const result = await loadLifeContext('life-work');
    expect(result).toBeNull();
  });

  it('reads sensitive topics from _sensitive/ subdirectory', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('finance', {
      'summary.md': '# Finance Summary\n\nAbstract overview.',
    }, true);

    const result = await loadLifeContext('life-finance');

    expect(result).toContain('Abstract overview.');
  });

  it('applies size budget when reading from vault', async () => {
    process.env.VAULT_PATH = tempDir;
    const largeContent = 'x'.repeat(200);
    await setupVaultTopic('work', {
      'summary.md': `# Summary\n${largeContent}`,
      'timeline.md': `# Timeline\n${largeContent}`,
      'entities.md': `# Entities\n${largeContent}`,
    });

    // Budget fits ~2 files
    const result = await loadLifeContext('life-work', 500);

    expect(result).toContain('## summary.md');
    expect(result).toContain('## timeline.md');
    expect(result).not.toContain('## entities.md');
    expect(result).toContain('[truncated');
  });
});

// ---- Drive fallback tests ----

describe('loadLifeContext — Drive fallback', () => {
  it('returns null for non-life-context agents', async () => {
    const result = await loadLifeContext('life-curator');
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
