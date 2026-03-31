import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureLifeContextFolders, TOPIC_FOLDERS, type FolderMap } from '../src/life-context-setup.js';
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

describe('ensureLifeContextFolders', () => {
  it('creates full folder tree when none exists', async () => {
    const client = createMockClient({
      driveSearch: vi.fn().mockResolvedValue({ files: [] }),
      driveCreateFolder: vi.fn()
        .mockResolvedValueOnce({ folder_id: 'root-id', name: 'life-context', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'work-id', name: 'work', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'travel-id', name: 'travel', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'finance-id', name: 'finance', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'health-id', name: 'health', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'social-id', name: 'social', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'hobbies-id', name: 'hobbies', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'meta-id', name: '_meta', web_view_link: null }),
      driveWrite: vi.fn().mockResolvedValue({ file_id: 'map-id', name: 'folder-map.json', mime_type: 'application/json', web_view_link: null }),
    });

    const result = await ensureLifeContextFolders(client);

    expect(result.root).toBe('root-id');
    expect(result.topics.work).toBe('work-id');
    expect(result.topics.travel).toBe('travel-id');
    expect(result.meta).toBe('meta-id');
    // Root folder created first
    expect(client.driveCreateFolder).toHaveBeenCalledWith('life-context', undefined);
    // Topic folders created under root
    expect(client.driveCreateFolder).toHaveBeenCalledWith('work', 'root-id');
    // folder-map.json written to _meta
    expect(client.driveWrite).toHaveBeenCalledWith(
      'folder-map.json',
      expect.stringContaining('"root": "root-id"'),
      'text',
    );
  });

  it('reuses existing folders when folder-map.json exists', async () => {
    const existingMap: FolderMap = {
      root: 'existing-root',
      topics: {
        work: 'existing-work',
        travel: 'existing-travel',
        finance: 'existing-finance',
        health: 'existing-health',
        social: 'existing-social',
        hobbies: 'existing-hobbies',
      },
      meta: 'existing-meta',
    };

    const client = createMockClient({
      driveSearch: vi.fn().mockResolvedValue({
        files: [{ file_id: 'map-file-id', name: 'folder-map.json', mime_type: 'application/json' }],
      }),
      driveRead: vi.fn().mockResolvedValue({
        name: 'folder-map.json',
        mime_type: 'application/json',
        content: JSON.stringify(existingMap),
      }),
    });

    const result = await ensureLifeContextFolders(client);

    expect(result.root).toBe('existing-root');
    expect(result.topics.work).toBe('existing-work');
    expect(client.driveCreateFolder).not.toHaveBeenCalled();
  });

  it('creates missing topic folders when folder-map exists but is incomplete', async () => {
    const partialMap: FolderMap = {
      root: 'existing-root',
      topics: {
        work: 'existing-work',
        travel: '',
        finance: '',
        health: '',
        social: '',
        hobbies: '',
      },
      meta: 'existing-meta',
    };

    const client = createMockClient({
      driveSearch: vi.fn().mockResolvedValue({
        files: [{ file_id: 'map-file-id', name: 'folder-map.json', mime_type: 'application/json' }],
      }),
      driveRead: vi.fn().mockResolvedValue({
        name: 'folder-map.json',
        mime_type: 'application/json',
        content: JSON.stringify(partialMap),
      }),
      driveCreateFolder: vi.fn()
        .mockResolvedValueOnce({ folder_id: 'travel-id', name: 'travel', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'finance-id', name: 'finance', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'health-id', name: 'health', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'social-id', name: 'social', web_view_link: null })
        .mockResolvedValueOnce({ folder_id: 'hobbies-id', name: 'hobbies', web_view_link: null }),
      driveWrite: vi.fn().mockResolvedValue({ file_id: 'map-id', name: 'folder-map.json', mime_type: 'application/json', web_view_link: null }),
    });

    const result = await ensureLifeContextFolders(client);

    expect(result.topics.work).toBe('existing-work');
    expect(result.topics.travel).toBe('travel-id');
    // Only missing folders created
    expect(client.driveCreateFolder).toHaveBeenCalledTimes(5);
    expect(client.driveCreateFolder).not.toHaveBeenCalledWith('work', expect.anything());
    // Updated map written back
    expect(client.driveWrite).toHaveBeenCalled();
  });
});
