import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadLifeContext, _resetForTest, buildVaultIndex, getLifeContextToolArgs } from '../../src/ayumi/life-context-loader.js';
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

  it('emits an index block with summary body and file listing', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('work', {
      'summary.md': '---\ntier: 2\ndescription: work overview\n---\n# Work Summary\n\nProject updates.',
      'timeline.md': '---\ntier: 2\n---\n# Timeline\n\n- 2026-03-15 Meeting',
      'authored.md': '# Authored\n\nBlog post about work.',
    });

    const result = await loadLifeContext('life-work');

    expect(result).toContain('--- LIFE CONTEXT INDEX ---');
    expect(result).toContain('--- END LIFE CONTEXT INDEX ---');
    // summary.md body is inlined
    expect(result).toContain('# Work Summary');
    expect(result).toContain('Project updates.');
    // Other files appear in the listing (by name + size), NOT their bodies
    expect(result).toMatch(/- timeline\.md \(/);
    expect(result).toMatch(/- authored\.md \(/);
    expect(result).not.toContain('- 2026-03-15 Meeting');
    expect(result).not.toContain('Blog post about work.');
  });

  it('strips frontmatter from the inlined summary body', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('work', {
      'summary.md': '---\ntier: 2\ntopic: work\ntype: summary\n---\n# Work Summary\n\nContent.',
    });

    const result = await loadLifeContext('life-work');

    expect(result).not.toContain('tier: 2');
    expect(result).toContain('# Work Summary');
    expect(result).toContain('Content.');
  });

  it('inlines summary body when only summary.md exists', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('work', {
      'summary.md': '# Work\n\nJust a summary.',
    });

    const result = await loadLifeContext('life-work');

    expect(result).toContain('## summary.md');
    expect(result).toContain('Just a summary.');
  });

  it('returns null when topic directory does not exist', async () => {
    process.env.VAULT_PATH = tempDir;
    const result = await loadLifeContext('life-work');
    expect(result).toBeNull();
  });

  it('reads sensitive topics from _sensitive/ subdirectory', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('finance', {
      'summary.md': '# Finance Summary\n\nAbstract overview.',
    }, true);

    const result = await loadLifeContext('life-finance');

    expect(result).toContain('## summary.md');
    expect(result).toContain('Abstract overview.');
  });

  it('lists all .md files dynamically in the index, not just hardcoded names', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('work', {
      'summary.md': '# Summary\nOverview.',
      'authored.md': '# Authored\nBlog posts.',
      'weekly-report.md': '# Weekly\nReport data.',
    });

    const result = await loadLifeContext('life-work');

    // summary body inlined
    expect(result).toContain('# Summary');
    // other files appear by name in the listing
    expect(result).toMatch(/- authored\.md /);
    expect(result).toMatch(/- weekly-report\.md /);
  });

  it('inlines _identity/writing-style.md body when present', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('work', {
      'summary.md': '# Summary\nWork overview.',
    });
    await mkdir(join(tempDir, '_identity'), { recursive: true });
    await writeFile(
      join(tempDir, '_identity', 'writing-style.md'),
      '---\ntype: identity\n---\n# Writing Style\n\nCasual, concise.',
    );

    const result = await loadLifeContext('life-work');

    expect(result).toContain('## writing-style.md');
    expect(result).toContain('Casual, concise.');
    expect(result).not.toContain('type: identity');
  });

  it('works without _identity/writing-style.md', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('work', {
      'summary.md': '# Summary\nWork overview.',
    });

    const result = await loadLifeContext('life-work');

    expect(result).toContain('# Summary');
    expect(result).not.toContain('writing-style');
  });

  it('lists files alphabetically in the index', async () => {
    process.env.VAULT_PATH = tempDir;
    await setupVaultTopic('hobbies', {
      'cycling.md': '# Cycling\nRoad biking.',
      'authored.md': '# Authored\nBlog posts.',
      'mountains.md': '# Mountains\nMountaineering.',
    });

    const result = await loadLifeContext('life-hobbies');

    // Alphabetical in the listing: authored.md, cycling.md, mountains.md
    const authoredIdx = result!.indexOf('- authored.md');
    const cyclingIdx = result!.indexOf('- cycling.md');
    const mountainsIdx = result!.indexOf('- mountains.md');
    expect(authoredIdx).toBeGreaterThan(-1);
    expect(authoredIdx).toBeLessThan(cyclingIdx);
    expect(cyclingIdx).toBeLessThan(mountainsIdx);
  });

  it('index block stays small regardless of topic file count', async () => {
    process.env.VAULT_PATH = tempDir;
    const bigBody = 'x'.repeat(20_000);
    const files: Record<string, string> = { 'summary.md': '# Hobbies\nShort summary.' };
    for (let i = 0; i < 50; i++) {
      files[`file-${String(i).padStart(3, '0')}.md`] = `# File ${i}\n${bigBody}`;
    }
    await setupVaultTopic('hobbies', files);

    const result = await loadLifeContext('life-hobbies');

    expect(result).not.toBeNull();
    // Bodies of non-summary files must NOT be inlined
    expect(result).not.toContain(bigBody);
    // Block should stay small — index only, no file bodies
    expect(result!.length).toBeLessThan(10 * 1024);
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

  it('inlines summary.md body and emits the index block', async () => {
    setupDriveFolders([
      makeDriveFile('summary.md', '2026-03-15T00:00:00Z'),
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'summary.md',
      mime_type: 'text/plain',
      content: '# Work Summary\n\nKey project updates.',
    } satisfies DriveReadResult);

    const result = await loadLifeContext('life-work');
    expect(result).toContain('--- LIFE CONTEXT INDEX ---');
    expect(result).toContain('## summary.md');
    expect(result).toContain('Key project updates.');
    expect(result).toContain('--- END LIFE CONTEXT INDEX ---');
  });

  it('lists non-summary files by name only (no body inlined)', async () => {
    setupDriveFolders([
      makeDriveFile('summary.md', '2026-03-15T00:00:00Z'),
      makeDriveFile('timeline.md', '2026-03-10T00:00:00Z'),
      makeDriveFile('entities.md', '2026-03-01T00:00:00Z'),
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockImplementation((fileId: string) => {
      return Promise.resolve({
        name: fileId.replace('id-', ''),
        mime_type: 'text/plain',
        content: `# Heading\nBody for ${fileId}`,
      } satisfies DriveReadResult);
    });

    const result = await loadLifeContext('life-work');
    // summary.md body inlined
    expect(result).toContain('Body for id-summary.md');
    // Other files appear by name in the listing, NOT their bodies
    expect(result).toMatch(/- timeline\.md /);
    expect(result).toMatch(/- entities\.md /);
    expect(result).not.toContain('Body for id-timeline.md');
    expect(result).not.toContain('Body for id-entities.md');
    // Drive loader only reads summary.md's content
    expect(mockClient.driveRead).toHaveBeenCalledTimes(1);
  });

  it('lists all .md files in the index, excludes non-.md files', async () => {
    setupDriveFolders([
      makeDriveFile('summary.md', '2026-03-15T00:00:00Z'),
      makeDriveFile('weekly-report.md', '2026-03-14T00:00:00Z'),
      makeDriveFile('notes.md', '2026-03-13T00:00:00Z'),
      { ...makeDriveFile('data.json', '2026-03-16T00:00:00Z'), name: 'data.json' },
    ]);
    (mockClient.driveRead as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'summary.md',
      mime_type: 'text/plain',
      content: '# Summary\nInlined.',
    } satisfies DriveReadResult);

    const result = await loadLifeContext('life-work');
    expect(result).toMatch(/- weekly-report\.md /);
    expect(result).toMatch(/- notes\.md /);
    expect(result).not.toContain('data.json');
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

// ---- buildVaultIndex tests ----

describe('buildVaultIndex — local filesystem', () => {
  it('lists .md files in a topic directory with size and description', async () => {
    await setupVaultTopic('hobbies', {
      'summary.md': '---\ndescription: hobbies overview\n---\n# Hobbies\n\nOverview.',
      'mountains.md': '---\ndescription: mountaineering log 2004-2019\n---\n# Mountains\n\nBody.',
      'cycling.md': '# Cycling\n\nNo frontmatter.',
    });

    const index = await buildVaultIndex(tempDir, 'hobbies');

    expect(index).not.toBeNull();
    expect(index!.summary).toContain('# Hobbies');
    expect(index!.files.map((f) => f.name).sort()).toEqual(['cycling.md', 'mountains.md', 'summary.md']);

    const mountains = index!.files.find((f) => f.name === 'mountains.md')!;
    expect(mountains.description).toBe('mountaineering log 2004-2019');
    expect(mountains.sizeBytes).toBeGreaterThan(0);

    const cycling = index!.files.find((f) => f.name === 'cycling.md')!;
    expect(cycling.description).toBeNull();
  });

  it('returns null when the topic directory does not exist', async () => {
    const index = await buildVaultIndex(tempDir, 'hobbies');
    expect(index).toBeNull();
  });

  it('resolves sensitive topics to topics/_sensitive/', async () => {
    await setupVaultTopic('finance', { 'summary.md': '# Finance\n\nAbstract.' }, true);
    const index = await buildVaultIndex(tempDir, 'finance');
    expect(index).not.toBeNull();
    expect(index!.files.map((f) => f.name)).toContain('summary.md');
  });
});
