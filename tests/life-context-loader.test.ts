import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock broker-client module before importing the loader
vi.mock('../src/broker-client.js', () => ({
  createBrokerClient: vi.fn(),
}));

import { loadLifeContext, _resetForTest } from '../src/ayumi/life-context-loader.js';
import { createBrokerClient } from '../src/broker-client.js';

const mockCreateBrokerClient = vi.mocked(createBrokerClient);

const FOLDER_MAP = {
  root: 'root-id',
  topics: { work: 'work-id', travel: 'travel-id', finance: 'finance-id', health: 'health-id', social: 'social-id', hobbies: 'hobbies-id' },
  meta: 'meta-id',
};

function setupMockClient(overrides: Record<string, unknown> = {}) {
  const client = {
    driveSearch: vi.fn().mockResolvedValue({ files: [] }),
    driveRead: vi.fn()
      .mockResolvedValueOnce({ content: JSON.stringify(FOLDER_MAP) }) // folder-map.json
      .mockResolvedValueOnce({ content: '# Work Summary\nDetails.' }) // summary.md
      .mockResolvedValueOnce({ content: '- 2025-01 Started job' }) // timeline.md
      .mockResolvedValueOnce({ content: '## People\n- Alice' }), // entities.md
    driveList: vi.fn()
      // First call: root listing (for loadFolderMap)
      .mockResolvedValueOnce({
        files: [{ file_id: 'map-file-id', name: 'folder-map.json' }],
      })
      // Second call: topic folder listing
      .mockResolvedValueOnce({
        files: [
          { file_id: 'summary-id', name: 'summary.md' },
          { file_id: 'timeline-id', name: 'timeline.md' },
          { file_id: 'entities-id', name: 'entities.md' },
        ],
      }),
    ...overrides,
  };
  mockCreateBrokerClient.mockReturnValue(client as any);
  return client;
}

beforeEach(() => {
  _resetForTest();
  vi.restoreAllMocks();
  // Re-apply the mock since restoreAllMocks clears it
  vi.mocked(createBrokerClient).mockReset();
});

describe('loadLifeContext', () => {
  describe('agent name mapping', () => {
    it('maps life-work to work topic', async () => {
      process.env.BROKER_URL = 'http://broker';
      process.env.BROKER_API_SECRET = 'secret';
      process.env.BROKER_TENANT_ID = 'tenant';
      process.env.BROKER_ACTOR_ID = 'actor';
      const client = setupMockClient();

      const result = await loadLifeContext('life-work');

      expect(result).not.toBeNull();
      expect(client.driveList).toHaveBeenCalledWith('work-id');
    });

    it('maps life-travel to travel topic', async () => {
      process.env.BROKER_URL = 'http://broker';
      process.env.BROKER_API_SECRET = 'secret';
      process.env.BROKER_TENANT_ID = 'tenant';
      process.env.BROKER_ACTOR_ID = 'actor';
      const client = setupMockClient();

      await loadLifeContext('life-travel');
      expect(client.driveList).toHaveBeenCalledWith('travel-id');
    });

    it('maps life-social to social topic', async () => {
      process.env.BROKER_URL = 'http://broker';
      process.env.BROKER_API_SECRET = 'secret';
      process.env.BROKER_TENANT_ID = 'tenant';
      process.env.BROKER_ACTOR_ID = 'actor';
      const client = setupMockClient();

      await loadLifeContext('life-social');
      expect(client.driveList).toHaveBeenCalledWith('social-id');
    });

    it('maps life-hobbies to hobbies topic', async () => {
      process.env.BROKER_URL = 'http://broker';
      process.env.BROKER_API_SECRET = 'secret';
      process.env.BROKER_TENANT_ID = 'tenant';
      process.env.BROKER_ACTOR_ID = 'actor';
      const client = setupMockClient();

      await loadLifeContext('life-hobbies');
      expect(client.driveList).toHaveBeenCalledWith('hobbies-id');
    });
  });

  describe('non-life agents return null', () => {
    it.each(['life-router', 'curator', 'pm', 'engineer', 'unknown'])('%s returns null', async (name) => {
      const result = await loadLifeContext(name);
      expect(result).toBeNull();
    });
  });

  describe('happy path', () => {
    beforeEach(() => {
      process.env.BROKER_URL = 'http://broker';
      process.env.BROKER_API_SECRET = 'secret';
      process.env.BROKER_TENANT_ID = 'tenant';
      process.env.BROKER_ACTOR_ID = 'actor';
    });

    afterEach(() => {
      delete process.env.BROKER_URL;
      delete process.env.BROKER_API_SECRET;
      delete process.env.BROKER_TENANT_ID;
      delete process.env.BROKER_ACTOR_ID;
    });

    it('returns formatted context string with all three files', async () => {
      setupMockClient();

      const result = await loadLifeContext('life-work');

      expect(result).not.toBeNull();
      expect(result).toContain('--- LIFE CONTEXT DATA ---');
      expect(result).toContain('--- END LIFE CONTEXT DATA ---');
      expect(result).toContain('## summary.md');
      expect(result).toContain('# Work Summary');
      expect(result).toContain('## timeline.md');
      expect(result).toContain('- 2025-01 Started job');
      expect(result).toContain('## entities.md');
      expect(result).toContain('## People');
    });

    it('skips files not present in folder listing', async () => {
      const client = setupMockClient();
      client.driveList
        .mockReset()
        // Root listing (for loadFolderMap)
        .mockResolvedValueOnce({
          files: [{ file_id: 'map-file-id', name: 'folder-map.json' }],
        })
        // Topic listing — only summary.md present
        .mockResolvedValueOnce({
          files: [{ file_id: 'summary-id', name: 'summary.md' }],
        });
      // Only folder-map + summary reads
      client.driveRead
        .mockReset()
        .mockResolvedValueOnce({ content: JSON.stringify(FOLDER_MAP) })
        .mockResolvedValueOnce({ content: '# Summary only' });

      const result = await loadLifeContext('life-work');

      expect(result).toContain('## summary.md');
      expect(result).not.toContain('## timeline.md');
      expect(result).not.toContain('## entities.md');
    });
  });

  describe('missing broker env vars', () => {
    it('returns null with warning log', async () => {
      delete process.env.BROKER_URL;
      delete process.env.BROKER_API_SECRET;
      delete process.env.BROKER_TENANT_ID;
      delete process.env.BROKER_ACTOR_ID;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await loadLifeContext('life-work');

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing broker env vars'),
      );
      warnSpy.mockRestore();
    });

    it('warns only once across multiple calls', async () => {
      delete process.env.BROKER_URL;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await loadLifeContext('life-work');
      await loadLifeContext('life-travel');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  describe('broker errors', () => {
    beforeEach(() => {
      process.env.BROKER_URL = 'http://broker';
      process.env.BROKER_API_SECRET = 'secret';
      process.env.BROKER_TENANT_ID = 'tenant';
      process.env.BROKER_ACTOR_ID = 'actor';
    });

    afterEach(() => {
      delete process.env.BROKER_URL;
      delete process.env.BROKER_API_SECRET;
      delete process.env.BROKER_TENANT_ID;
      delete process.env.BROKER_ACTOR_ID;
    });

    it('returns null when root driveList throws', async () => {
      const client = setupMockClient();
      client.driveList.mockReset().mockRejectedValue(new Error('Network error'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadLifeContext('life-work');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error loading context'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it('returns null when folder-map.json is not found in root listing', async () => {
      const client = setupMockClient();
      client.driveList.mockReset().mockResolvedValue({ files: [] });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadLifeContext('life-work');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('folder-map.json not found'),
      );
      errorSpy.mockRestore();
    });

    it('returns null when topic folder is empty', async () => {
      const client = setupMockClient();
      client.driveList
        .mockReset()
        // Root listing returns folder-map.json
        .mockResolvedValueOnce({
          files: [{ file_id: 'map-file-id', name: 'folder-map.json' }],
        })
        // Topic listing is empty
        .mockResolvedValueOnce({ files: [] });
      client.driveRead
        .mockReset()
        .mockResolvedValueOnce({ content: JSON.stringify(FOLDER_MAP) });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await loadLifeContext('life-work');

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No files in work folder'),
      );
      warnSpy.mockRestore();
    });
  });
});
