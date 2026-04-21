import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock broker-client module before importing the loader
vi.mock('../src/broker-client.js', () => ({
  createBrokerClient: vi.fn(),
}));

import { loadLifeContext, _resetForTest } from '../src/ayumi/life-context-loader.js';
import { createBrokerClient } from '../src/broker-client.js';

const mockCreateBrokerClient = vi.mocked(createBrokerClient);

const TOPIC_FOLDERS = [
  { file_id: 'work-id', name: 'work', mime_type: 'application/vnd.google-apps.folder' },
  { file_id: 'travel-id', name: 'travel', mime_type: 'application/vnd.google-apps.folder' },
  { file_id: 'finance-id', name: 'finance', mime_type: 'application/vnd.google-apps.folder' },
  { file_id: 'health-id', name: 'health', mime_type: 'application/vnd.google-apps.folder' },
  { file_id: 'social-id', name: 'social', mime_type: 'application/vnd.google-apps.folder' },
  { file_id: 'hobbies-id', name: 'hobbies', mime_type: 'application/vnd.google-apps.folder' },
  { file_id: 'meta-id', name: '_meta', mime_type: 'application/vnd.google-apps.folder' },
];

const TOPIC_FILES = [
  { file_id: 'summary-id', name: 'summary.md' },
  { file_id: 'timeline-id', name: 'timeline.md' },
  { file_id: 'entities-id', name: 'entities.md' },
];

function setupMockClient(overrides: Record<string, unknown> = {}) {
  const client = {
    driveSearch: vi.fn().mockResolvedValue({
      files: [{ file_id: 'lc-folder-id', name: 'life-context', mime_type: 'application/vnd.google-apps.folder' }],
    }),
    driveRead: vi.fn()
      .mockResolvedValueOnce({ content: '# Work Summary\nDetails.' }) // summary.md
      .mockResolvedValueOnce({ content: '- 2025-01 Started job' }) // timeline.md
      .mockResolvedValueOnce({ content: '## People\n- Alice' }), // entities.md
    driveList: vi.fn()
      // First call: life-context/ folder listing (discover topic subfolders)
      .mockResolvedValueOnce({ files: TOPIC_FOLDERS })
      // Second call: topic folder listing
      .mockResolvedValueOnce({ files: TOPIC_FILES }),
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

    it('maps life-work to work topic', async () => {
      const client = setupMockClient();

      const result = await loadLifeContext('life-work');

      expect(result).not.toBeNull();
      expect(client.driveSearch).toHaveBeenCalledWith('life-context');
      expect(client.driveList).toHaveBeenCalledWith('lc-folder-id');
      expect(client.driveList).toHaveBeenCalledWith('work-id');
    });

    it('maps life-travel to travel topic', async () => {
      const client = setupMockClient();

      await loadLifeContext('life-travel');
      expect(client.driveList).toHaveBeenCalledWith('travel-id');
    });

    it('maps life-social to social topic', async () => {
      const client = setupMockClient();

      await loadLifeContext('life-social');
      expect(client.driveList).toHaveBeenCalledWith('social-id');
    });

    it('maps life-hobbies to hobbies topic', async () => {
      const client = setupMockClient();

      await loadLifeContext('life-hobbies');
      expect(client.driveList).toHaveBeenCalledWith('hobbies-id');
    });

    it('caches topic folder IDs across calls', async () => {
      const client = setupMockClient();
      // Add extra driveList/driveRead mocks for second call
      client.driveList.mockResolvedValueOnce({ files: TOPIC_FILES });
      client.driveRead
        .mockResolvedValueOnce({ content: '# Travel Summary' })
        .mockResolvedValueOnce({ content: '- trip' })
        .mockResolvedValueOnce({ content: '## Contacts' });

      await loadLifeContext('life-work');
      await loadLifeContext('life-travel');

      // driveSearch and life-context listing should only happen once
      expect(client.driveSearch).toHaveBeenCalledTimes(1);
      // 1 for life-context listing + 1 for work topic + 1 for travel topic = 3
      expect(client.driveList).toHaveBeenCalledTimes(3);
    });
  });

  describe('non-life agents return null', () => {
    it.each(['life-router', 'life-curator', 'pm', 'engineer', 'unknown'])('%s returns null', async (name) => {
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

    it('emits an index block with summary body inlined and other files listed', async () => {
      setupMockClient();

      const result = await loadLifeContext('life-work');

      expect(result).not.toBeNull();
      expect(result).toContain('--- LIFE CONTEXT INDEX ---');
      expect(result).toContain('--- END LIFE CONTEXT INDEX ---');
      // summary.md body is inlined
      expect(result).toContain('## summary.md');
      expect(result).toContain('# Work Summary');
      // Other files appear by name in the listing, not their bodies
      expect(result).toMatch(/- timeline\.md /);
      expect(result).toMatch(/- entities\.md /);
      expect(result).not.toContain('- 2025-01 Started job');
      expect(result).not.toContain('## People');
    });

    it('skips files not present in folder listing', async () => {
      const client = setupMockClient();
      client.driveList
        .mockReset()
        .mockResolvedValueOnce({ files: TOPIC_FOLDERS })
        // Topic listing — only summary.md present
        .mockResolvedValueOnce({ files: [{ file_id: 'summary-id', name: 'summary.md' }] });
      client.driveRead
        .mockReset()
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

    it('returns null when driveSearch throws', async () => {
      const client = setupMockClient();
      client.driveSearch.mockReset().mockRejectedValue(new Error('Network error'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadLifeContext('life-work');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error loading context'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it('returns null when life-context folder not found', async () => {
      const client = setupMockClient();
      client.driveSearch.mockReset().mockResolvedValue({ files: [] });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadLifeContext('life-work');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('life-context folder not found'),
      );
      errorSpy.mockRestore();
    });

    it('returns null when topic folder not found in life-context', async () => {
      const client = setupMockClient();
      client.driveList.mockReset().mockResolvedValue({
        files: [{ file_id: 'other-id', name: 'other', mime_type: 'application/vnd.google-apps.folder' }],
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadLifeContext('life-work');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('No folder found for topic "work"'),
      );
      errorSpy.mockRestore();
    });

    it('returns null when topic folder is empty', async () => {
      const client = setupMockClient();
      client.driveList
        .mockReset()
        .mockResolvedValueOnce({ files: TOPIC_FOLDERS })
        .mockResolvedValueOnce({ files: [] });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await loadLifeContext('life-work');

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No .md files in work folder'),
      );
      warnSpy.mockRestore();
    });

    it('returns null when topic folder driveList throws', async () => {
      const client = setupMockClient();
      client.driveList
        .mockReset()
        .mockResolvedValueOnce({ files: TOPIC_FOLDERS })
        .mockRejectedValueOnce(new Error('Drive timeout'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await loadLifeContext('life-work');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error loading context'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });
});
