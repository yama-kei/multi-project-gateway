import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadDriveContext, parseContextPath } from '../../src/ayumi/context-loader.js';
import type { BrokerClient } from '../../src/broker-client.js';

function createMockClient(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    health: vi.fn(),
    gmailSearch: vi.fn(),
    gmailMessages: vi.fn(),
    calendarEvents: vi.fn(),
    driveRead: vi.fn(),
    driveWrite: vi.fn(),
    driveSearch: vi.fn(),
    driveCreateFolder: vi.fn(),
    driveList: vi.fn(),
    ...overrides,
  } as unknown as BrokerClient;
}

const FOLDER_MAP = {
  root: 'root-id',
  topics: {
    work: 'work-folder-id',
    travel: 'travel-folder-id',
    finance: 'finance-folder-id',
    health: 'health-folder-id',
    social: 'social-folder-id',
    hobbies: 'hobbies-folder-id',
  },
  meta: 'meta-id',
};

describe('parseContextPath', () => {
  it('parses a valid path', () => {
    expect(parseContextPath('/life-context/work/summary.md')).toEqual({
      topic: 'work',
      filename: 'summary.md',
    });
  });

  it('returns null for invalid paths', () => {
    expect(parseContextPath('/invalid/path')).toBeNull();
    expect(parseContextPath('summary.md')).toBeNull();
    expect(parseContextPath('/life-context/work/')).toBeNull();
  });
});

describe('loadDriveContext', () => {
  it('returns empty for no paths', async () => {
    const client = createMockClient();
    const result = await loadDriveContext([], client);
    expect(result.content).toBe('');
    expect(result.loaded).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('loads files from Drive and formats with headers', async () => {
    const client = createMockClient({
      driveSearch: vi.fn().mockResolvedValue({
        files: [{ file_id: 'map-id', name: 'folder-map.json' }],
      }),
      driveRead: vi.fn()
        .mockResolvedValueOnce({ content: JSON.stringify(FOLDER_MAP) }) // folder-map.json
        .mockResolvedValueOnce({ content: '# Work Summary\nDetails here.' }) // summary.md
        .mockResolvedValueOnce({ content: '- 2025-01 Started job' }), // timeline.md
      driveList: vi.fn().mockResolvedValue({
        files: [
          { file_id: 'summary-id', name: 'summary.md' },
          { file_id: 'timeline-id', name: 'timeline.md' },
        ],
      }),
    });

    const result = await loadDriveContext(
      ['/life-context/work/summary.md', '/life-context/work/timeline.md'],
      client,
    );

    expect(result.loaded).toEqual([
      '/life-context/work/summary.md',
      '/life-context/work/timeline.md',
    ]);
    expect(result.missing).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.content).toContain('### summary.md');
    expect(result.content).toContain('# Work Summary');
    expect(result.content).toContain('### timeline.md');
    expect(result.content).toContain('- 2025-01 Started job');
  });

  it('reports missing files gracefully', async () => {
    const client = createMockClient({
      driveSearch: vi.fn().mockResolvedValue({
        files: [{ file_id: 'map-id', name: 'folder-map.json' }],
      }),
      driveRead: vi.fn()
        .mockResolvedValueOnce({ content: JSON.stringify(FOLDER_MAP) }) // folder-map.json
        .mockResolvedValueOnce({ content: '# Summary' }), // summary.md
      driveList: vi.fn().mockResolvedValue({
        files: [{ file_id: 'summary-id', name: 'summary.md' }],
        // entities.md not in listing
      }),
    });

    const result = await loadDriveContext(
      ['/life-context/work/summary.md', '/life-context/work/entities.md'],
      client,
    );

    expect(result.loaded).toEqual(['/life-context/work/summary.md']);
    expect(result.missing).toEqual(['/life-context/work/entities.md']);
    expect(result.content).toContain('entities.md not found');
  });

  it('returns missing when folder map is not found', async () => {
    const client = createMockClient({
      driveSearch: vi.fn().mockResolvedValue({ files: [] }),
    });

    const result = await loadDriveContext(
      ['/life-context/work/summary.md'],
      client,
    );

    expect(result.loaded).toEqual([]);
    expect(result.missing).toEqual(['/life-context/work/summary.md']);
    expect(result.content).toContain('folder map not found');
  });

  it('truncates lower-priority files when exceeding token budget', async () => {
    // Create a large content that exceeds the budget
    const largeSummary = 'S'.repeat(190_000); // summary.md — priority 0, kept in full
    const largeTimeline = 'T'.repeat(50_000); // timeline.md — priority 1, should be truncated

    const client = createMockClient({
      driveSearch: vi.fn().mockResolvedValue({
        files: [{ file_id: 'map-id', name: 'folder-map.json' }],
      }),
      driveRead: vi.fn()
        .mockResolvedValueOnce({ content: JSON.stringify(FOLDER_MAP) })
        .mockResolvedValueOnce({ content: largeSummary })
        .mockResolvedValueOnce({ content: largeTimeline }),
      driveList: vi.fn().mockResolvedValue({
        files: [
          { file_id: 's-id', name: 'summary.md' },
          { file_id: 't-id', name: 'timeline.md' },
        ],
      }),
    });

    const result = await loadDriveContext(
      ['/life-context/work/summary.md', '/life-context/work/timeline.md'],
      client,
    );

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('truncated to fit token budget');
    // summary.md should be present in full
    expect(result.content).toContain(largeSummary);
  });

  it('handles driveRead failures for individual files', async () => {
    const client = createMockClient({
      driveSearch: vi.fn().mockResolvedValue({
        files: [{ file_id: 'map-id', name: 'folder-map.json' }],
      }),
      driveRead: vi.fn()
        .mockResolvedValueOnce({ content: JSON.stringify(FOLDER_MAP) })
        .mockRejectedValueOnce(new Error('Drive error')), // summary.md fails
      driveList: vi.fn().mockResolvedValue({
        files: [{ file_id: 's-id', name: 'summary.md' }],
      }),
    });

    const result = await loadDriveContext(
      ['/life-context/work/summary.md'],
      client,
    );

    expect(result.loaded).toEqual([]);
    expect(result.missing).toEqual(['/life-context/work/summary.md']);
  });
});
