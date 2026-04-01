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
});
