import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrokerClient } from '../src/broker-client.js';

function createMockClient(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    health: vi.fn().mockResolvedValue({ ok: true }),
    gmailSearch: vi.fn(),
    gmailMessages: vi.fn(),
    calendarEvents: vi.fn(),
    driveRead: vi.fn(),
    driveWrite: vi.fn(),
    driveSearch: vi.fn(),
    driveCreateFolder: vi.fn(),
    driveList: vi.fn(),
    ...overrides,
  } as BrokerClient;
}

describe('loadLifeContext', () => {
  let loadLifeContext: typeof import('../src/life-context-loader.js').loadLifeContext;
  let mockClient: BrokerClient;

  beforeEach(async () => {
    vi.resetModules();
    mockClient = createMockClient();
    vi.doMock('../src/broker-client.js', () => ({
      createBrokerClientFromEnv: () => mockClient,
    }));
    const mod = await import('../src/life-context-loader.js');
    loadLifeContext = mod.loadLifeContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for non-life-context agents', async () => {
    expect(await loadLifeContext('pm')).toBeNull();
    expect(await loadLifeContext('engineer')).toBeNull();
    expect(await loadLifeContext('life-router')).toBeNull();
    expect(await loadLifeContext('curator')).toBeNull();
  });

  it('returns null when folder-map.json is not found in Drive', async () => {
    mockClient.driveSearch = vi.fn().mockResolvedValue({ files: [] });
    const result = await loadLifeContext('life-work');
    expect(result).toBeNull();
    expect(mockClient.driveSearch).toHaveBeenCalledWith('folder-map.json');
  });

  it('fetches and formats Drive context for life-work', async () => {
    const folderMap = {
      root: 'root-id',
      topics: { work: 'work-folder-id', travel: 't-id', finance: 'f-id', health: 'h-id', social: 's-id', hobbies: 'hb-id' },
      meta: 'meta-id',
    };

    mockClient.driveSearch = vi.fn().mockResolvedValue({
      files: [{ file_id: 'map-file-id', name: 'folder-map.json', mime_type: 'application/json', size_bytes: 200, modified_at: '', web_view_link: null }],
    });
    mockClient.driveRead = vi.fn()
      .mockResolvedValueOnce({ name: 'folder-map.json', mime_type: 'application/json', content: JSON.stringify(folderMap) })
      .mockResolvedValueOnce({ name: 'summary.md', mime_type: 'text/markdown', content: '# Work Summary\nQ1 projects...' })
      .mockResolvedValueOnce({ name: 'timeline.md', mime_type: 'text/markdown', content: '## Jan\n- Started project X' });
    mockClient.driveList = vi.fn().mockResolvedValue({
      files: [
        { file_id: 'sum-id', name: 'summary.md', mime_type: 'text/markdown', size_bytes: 100, modified_at: '', web_view_link: null },
        { file_id: 'tl-id', name: 'timeline.md', mime_type: 'text/markdown', size_bytes: 100, modified_at: '', web_view_link: null },
      ],
    });

    const result = await loadLifeContext('life-work');

    expect(result).not.toBeNull();
    expect(result).toContain('--- LIFE CONTEXT DATA ---');
    expect(result).toContain('## summary.md');
    expect(result).toContain('# Work Summary');
    expect(result).toContain('## timeline.md');
    expect(result).toContain('--- END LIFE CONTEXT DATA ---');
    // driveList called with the work folder ID from folder-map
    expect(mockClient.driveList).toHaveBeenCalledWith('work-folder-id');
  });

  it('returns null when topic folder is empty', async () => {
    const folderMap = {
      root: 'root-id',
      topics: { work: 'work-folder-id', travel: 't-id', finance: 'f-id', health: 'h-id', social: 's-id', hobbies: 'hb-id' },
      meta: 'meta-id',
    };

    mockClient.driveSearch = vi.fn().mockResolvedValue({
      files: [{ file_id: 'map-file-id', name: 'folder-map.json', mime_type: 'application/json', size_bytes: 200, modified_at: '', web_view_link: null }],
    });
    mockClient.driveRead = vi.fn().mockResolvedValueOnce({
      name: 'folder-map.json', mime_type: 'application/json', content: JSON.stringify(folderMap),
    });
    mockClient.driveList = vi.fn().mockResolvedValue({ files: [] });

    const result = await loadLifeContext('life-work');

    expect(result).toBeNull();
  });

  it('returns null when broker API throws', async () => {
    mockClient.driveSearch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await loadLifeContext('life-travel');

    expect(result).toBeNull();
  });

  it('maps all four topic agents correctly', async () => {
    // Just verify non-null agents reach the broker (they'll fail at search, returning null)
    mockClient.driveSearch = vi.fn().mockResolvedValue({ files: [] });

    for (const agent of ['life-work', 'life-travel', 'life-social', 'life-hobbies']) {
      await loadLifeContext(agent);
    }

    expect(mockClient.driveSearch).toHaveBeenCalledTimes(4);
  });

  it('stops reading files when aggregate size would exceed 32KB limit', async () => {
    const folderMap = {
      root: 'root-id',
      topics: { work: 'work-folder-id', travel: 't-id', finance: 'f-id', health: 'h-id', social: 's-id', hobbies: 'hb-id' },
      meta: 'meta-id',
    };
    // First file is 30KB, second is 5KB — second should be skipped (would exceed 32KB)
    const bigContent = 'x'.repeat(30 * 1024);
    const smallContent = 'y'.repeat(5 * 1024);

    mockClient.driveSearch = vi.fn().mockResolvedValue({
      files: [{ file_id: 'map-file-id', name: 'folder-map.json', mime_type: 'application/json', size_bytes: 200, modified_at: '', web_view_link: null }],
    });
    mockClient.driveRead = vi.fn()
      .mockResolvedValueOnce({ name: 'folder-map.json', mime_type: 'application/json', content: JSON.stringify(folderMap) })
      .mockResolvedValueOnce({ name: 'big.md', mime_type: 'text/markdown', content: bigContent })
      .mockResolvedValueOnce({ name: 'small.md', mime_type: 'text/markdown', content: smallContent });
    mockClient.driveList = vi.fn().mockResolvedValue({
      files: [
        { file_id: 'big-id', name: 'big.md', mime_type: 'text/markdown', size_bytes: 30 * 1024, modified_at: '', web_view_link: null },
        { file_id: 'small-id', name: 'small.md', mime_type: 'text/markdown', size_bytes: 5 * 1024, modified_at: '', web_view_link: null },
      ],
    });

    const result = await loadLifeContext('life-work');

    expect(result).not.toBeNull();
    expect(result).toContain('## big.md');
    expect(result).not.toContain('## small.md');
    // driveRead called for folder-map + big.md + small.md (fetched then rejected by size check)
    expect(mockClient.driveRead).toHaveBeenCalledTimes(3);
  });
});
