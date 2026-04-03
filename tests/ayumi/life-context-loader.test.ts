import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadLifeContext,
  _resetForTest,
  parseFrontmatter,
  DEFAULT_TOPIC_SIZE_BUDGET,
} from '../../src/ayumi/life-context-loader.js';
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

function makeDriveFile(name: string, modified_at = '2026-03-01T00:00:00Z'): DriveFile {
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

const contentMap: Record<string, string> = {};

function setFileContent(name: string, content: string) {
  contentMap[`id-${name}`] = content;
}

beforeEach(() => {
  _resetForTest();
  Object.keys(contentMap).forEach((k) => delete contentMap[k]);

  process.env.BROKER_URL = 'http://localhost:9999';
  process.env.BROKER_API_SECRET = 'test-secret';
  process.env.BROKER_TENANT_ID = 'test-tenant';
  process.env.BROKER_ACTOR_ID = 'test-actor';

  mockClient = {
    health: vi.fn(),
    gmailSearch: vi.fn(),
    gmailMessages: vi.fn(),
    calendarEvents: vi.fn(),
    driveRead: vi.fn().mockImplementation((fileId: string) => {
      return Promise.resolve({
        name: fileId.replace('id-', ''),
        mime_type: 'text/plain',
        content: contentMap[fileId] ?? `content of ${fileId}`,
      } satisfies DriveReadResult);
    }),
    driveWrite: vi.fn(),
    driveSearch: vi.fn().mockResolvedValue({
      files: [makeFolderFile('life-context')],
    } satisfies DriveSearchResult),
    driveCreateFolder: vi.fn(),
    driveList: vi.fn().mockImplementation((folderId: string) => {
      if (folderId === 'folder-life-context') {
        return Promise.resolve({
          files: [makeFolderFile('work'), makeFolderFile('travel'), makeFolderFile('social'), makeFolderFile('hobbies')],
        } satisfies DriveListResult);
      }
      // Topic folder — return whatever topicFiles is set to
      return Promise.resolve({ files: topicFiles } satisfies DriveListResult);
    }),
  };
});

let topicFiles: DriveFile[] = [];

function setTopicFiles(files: DriveFile[]) {
  topicFiles = files;
}

// ---------------------------------------------------------------------------
// parseFrontmatter unit tests
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('returns empty meta for content without frontmatter', () => {
    const result = parseFrontmatter('# Hello\nWorld');
    expect(result.meta).toEqual({});
    expect(result.body).toBe('# Hello\nWorld');
  });

  it('parses delta frontmatter', () => {
    const content = '---\ntype: delta\nscan_range: 2026-04-07 to 2026-04-13\nsource_counts: { gmail: 5, calendar: 2 }\n---\n## New activity';
    const result = parseFrontmatter(content);
    expect(result.meta.type).toBe('delta');
    expect(result.meta.scan_range).toBe('2026-04-07 to 2026-04-13');
    expect(result.body).toBe('## New activity');
  });

  it('parses correction frontmatter', () => {
    const content = '---\ntype: correction\ncorrects: delta-2026-04-14.md\n---\nCorrected content here.';
    const result = parseFrontmatter(content);
    expect(result.meta.type).toBe('correction');
    expect(result.meta.corrects).toBe('delta-2026-04-14.md');
    expect(result.body).toBe('Corrected content here.');
  });

  it('treats incomplete frontmatter (no closing ---) as no frontmatter', () => {
    const content = '---\ntype: delta\nno closing delimiter';
    const result = parseFrontmatter(content);
    expect(result.meta).toEqual({});
    expect(result.body).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// loadLifeContext tests
// ---------------------------------------------------------------------------

describe('loadLifeContext', () => {
  it('returns null for non-life-context agents', async () => {
    const result = await loadLifeContext('curator');
    expect(result).toBeNull();
  });

  it('returns null for empty folder', async () => {
    setTopicFiles([]);
    const result = await loadLifeContext('life-work');
    expect(result).toBeNull();
  });

  // --- Base-only folder (backward compatibility) ---

  describe('base-only folder', () => {
    it('returns all three base files in canonical order', async () => {
      setTopicFiles([
        makeDriveFile('summary.md'),
        makeDriveFile('timeline.md'),
        makeDriveFile('entities.md'),
      ]);
      setFileContent('summary.md', '# Work Summary\nDetails.');
      setFileContent('timeline.md', '- 2025-01 Started job');
      setFileContent('entities.md', '## People\n- Alice');

      const result = await loadLifeContext('life-work');

      expect(result).toContain('--- LIFE CONTEXT DATA ---');
      expect(result).toContain('--- END LIFE CONTEXT DATA ---');
      expect(result).toContain('## summary.md');
      expect(result).toContain('# Work Summary');
      expect(result).toContain('## timeline.md');
      expect(result).toContain('## entities.md');

      // Verify order: summary before timeline before entities
      const summaryIdx = result!.indexOf('## summary.md');
      const timelineIdx = result!.indexOf('## timeline.md');
      const entitiesIdx = result!.indexOf('## entities.md');
      expect(summaryIdx).toBeLessThan(timelineIdx);
      expect(timelineIdx).toBeLessThan(entitiesIdx);
    });

    it('works with only summary.md', async () => {
      setTopicFiles([makeDriveFile('summary.md')]);
      setFileContent('summary.md', '# Summary only');

      const result = await loadLifeContext('life-work');
      expect(result).toContain('## summary.md');
      expect(result).not.toContain('## timeline.md');
      expect(result).not.toContain('## entities.md');
    });
  });

  // --- Base + deltas ---

  describe('base + delta files', () => {
    it('includes deltas after base files in chronological order', async () => {
      setTopicFiles([
        makeDriveFile('summary.md'),
        makeDriveFile('delta-2026-04-13.md'),
        makeDriveFile('delta-2026-04-07.md'),
      ]);
      setFileContent('summary.md', '# Work Summary');
      setFileContent('delta-2026-04-07.md', '---\ntype: delta\nscan_range: 2026-04-01 to 2026-04-07\n---\n## Week 1 activity');
      setFileContent('delta-2026-04-13.md', '---\ntype: delta\nscan_range: 2026-04-07 to 2026-04-13\n---\n## Week 2 activity');

      const result = await loadLifeContext('life-work');

      // Base first
      const summaryIdx = result!.indexOf('## summary.md');
      const delta07Idx = result!.indexOf('## delta-2026-04-07.md');
      const delta13Idx = result!.indexOf('## delta-2026-04-13.md');

      expect(summaryIdx).toBeLessThan(delta07Idx);
      expect(delta07Idx).toBeLessThan(delta13Idx);

      // Delta bodies should not include frontmatter
      expect(result).toContain('## Week 1 activity');
      expect(result).toContain('## Week 2 activity');
      expect(result).not.toContain('type: delta');
    });

    it('treats files without frontmatter as base files', async () => {
      setTopicFiles([
        makeDriveFile('summary.md'),
        makeDriveFile('notes.md'),
      ]);
      setFileContent('summary.md', '# Summary');
      setFileContent('notes.md', 'Some random notes without frontmatter');

      const result = await loadLifeContext('life-work');
      // notes.md should be treated as base and appear alongside summary
      expect(result).toContain('## notes.md');
      expect(result).toContain('Some random notes');
    });
  });

  // --- Corrections ---

  describe('corrections', () => {
    it('applies correction inline against referenced delta', async () => {
      setTopicFiles([
        makeDriveFile('summary.md'),
        makeDriveFile('delta-2026-04-07.md'),
        makeDriveFile('correction-2026-04-07.md'),
      ]);
      setFileContent('summary.md', '# Summary');
      setFileContent('delta-2026-04-07.md', '---\ntype: delta\nscan_range: 2026-04-01 to 2026-04-07\n---\nOriginal delta content');
      setFileContent('correction-2026-04-07.md', '---\ntype: correction\ncorrects: delta-2026-04-07.md\n---\nCorrected delta content');

      const result = await loadLifeContext('life-work');

      // The corrected content should replace the original
      expect(result).toContain('Corrected delta content');
      expect(result).not.toContain('Original delta content');
      // The correction file itself should not appear as a separate section
      expect(result).not.toContain('## correction-2026-04-07.md');
    });

    it('includes orphan correction as standalone when referenced delta is missing', async () => {
      setTopicFiles([
        makeDriveFile('summary.md'),
        makeDriveFile('correction-orphan.md'),
      ]);
      setFileContent('summary.md', '# Summary');
      setFileContent('correction-orphan.md', '---\ntype: correction\ncorrects: delta-2026-04-20.md\n---\nOrphan correction context');

      const result = await loadLifeContext('life-work');

      // Orphan correction should still appear
      expect(result).toContain('Orphan correction context');
    });
  });

  // --- Budget truncation ---

  describe('budget truncation', () => {
    it('always includes base files even if they exceed budget', async () => {
      setTopicFiles([makeDriveFile('summary.md')]);
      setFileContent('summary.md', 'x'.repeat(500));

      const result = await loadLifeContext('life-work', 10); // tiny budget
      expect(result).toContain('## summary.md');
      expect(result).not.toContain('[truncated');
    });

    it('drops oldest deltas first when over budget', async () => {
      const smallContent = 'x'.repeat(50);
      setTopicFiles([
        makeDriveFile('summary.md'),
        makeDriveFile('delta-2026-04-01.md'),
        makeDriveFile('delta-2026-04-08.md'),
        makeDriveFile('delta-2026-04-15.md'),
      ]);
      setFileContent('summary.md', '# Summary');
      setFileContent('delta-2026-04-01.md', `---\ntype: delta\nscan_range: 2026-03-25 to 2026-04-01\n---\n${smallContent}`);
      setFileContent('delta-2026-04-08.md', `---\ntype: delta\nscan_range: 2026-04-01 to 2026-04-08\n---\n${smallContent}`);
      setFileContent('delta-2026-04-15.md', `---\ntype: delta\nscan_range: 2026-04-08 to 2026-04-15\n---\n${smallContent}`);

      // Set budget to fit base + ~2 deltas
      const baseSize = new TextEncoder().encode('## summary.md\n# Summary').length;
      const deltaSize = new TextEncoder().encode(`## delta-2026-04-01.md\n${smallContent}`).length;
      const budget = baseSize + (deltaSize * 2) + 10; // fits 2 deltas

      const result = await loadLifeContext('life-work', budget);

      // Should include newest deltas (04-08 and 04-15), drop oldest (04-01)
      expect(result).toContain('## delta-2026-04-15.md');
      expect(result).toContain('## delta-2026-04-08.md');
      expect(result).not.toContain('## delta-2026-04-01.md');
    });

    it('includes truncation message with date range', async () => {
      const bigContent = 'x'.repeat(200);
      setTopicFiles([
        makeDriveFile('summary.md'),
        makeDriveFile('delta-2026-04-01.md'),
        makeDriveFile('delta-2026-04-08.md'),
        makeDriveFile('delta-2026-04-15.md'),
      ]);
      setFileContent('summary.md', '# Summary');
      setFileContent('delta-2026-04-01.md', `---\ntype: delta\nscan_range: 2026-03-25 to 2026-04-01\n---\n${bigContent}`);
      setFileContent('delta-2026-04-08.md', `---\ntype: delta\nscan_range: 2026-04-01 to 2026-04-08\n---\n${bigContent}`);
      setFileContent('delta-2026-04-15.md', `---\ntype: delta\nscan_range: 2026-04-08 to 2026-04-15\n---\n${bigContent}`);

      // Budget fits base + 1 delta
      const baseSize = new TextEncoder().encode('## summary.md\n# Summary').length;
      const deltaSize = new TextEncoder().encode(`## delta-2026-04-01.md\n${bigContent}`).length;
      const budget = baseSize + deltaSize + 10;

      const result = await loadLifeContext('life-work', budget);

      expect(result).toContain('[truncated: 2 deltas omitted, covering 2026-04-01 to 2026-04-08]');
    });

    it('skips correction when its referenced delta is dropped', async () => {
      const bigContent = 'x'.repeat(300);
      setTopicFiles([
        makeDriveFile('summary.md'),
        makeDriveFile('delta-2026-04-01.md'),
        makeDriveFile('delta-2026-04-15.md'),
        makeDriveFile('correction-01.md'),
      ]);
      setFileContent('summary.md', '# Summary');
      setFileContent('delta-2026-04-01.md', `---\ntype: delta\nscan_range: 2026-03-25 to 2026-04-01\n---\n${bigContent}`);
      setFileContent('delta-2026-04-15.md', `---\ntype: delta\nscan_range: 2026-04-08 to 2026-04-15\n---\nRecent delta`);
      setFileContent('correction-01.md', `---\ntype: correction\ncorrects: delta-2026-04-01.md\n---\n${bigContent}`);

      // Budget fits base + 1 delta (the recent one)
      const baseSize = new TextEncoder().encode('## summary.md\n# Summary').length;
      const result = await loadLifeContext('life-work', baseSize + 200);

      // Old delta dropped, so correction is also effectively skipped
      // (correction was applied to the delta before budget check, but delta was dropped)
      expect(result).toContain('## delta-2026-04-15.md');
      expect(result).not.toContain('## delta-2026-04-01.md');
    });
  });

  // --- Non-.md files ---

  it('ignores non-.md files', async () => {
    setTopicFiles([
      makeDriveFile('summary.md'),
      { ...makeDriveFile('data.json'), name: 'data.json', file_id: 'id-data.json' },
    ]);
    setFileContent('summary.md', '# Summary');

    const result = await loadLifeContext('life-work');
    expect(result).toContain('## summary.md');
    expect(result).not.toContain('data.json');
  });
});
