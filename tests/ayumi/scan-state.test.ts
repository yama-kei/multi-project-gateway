import { describe, it, expect, vi } from 'vitest';
import {
  readScanState,
  writeScanState,
  updateTopicScanState,
  type ScanState,
} from '../../src/ayumi/scan-state.js';
import type { BrokerClient } from '../../src/broker-client.js';

function mockClient(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    health: vi.fn(),
    gmailSearch: vi.fn(),
    gmailMessages: vi.fn(),
    calendarEvents: vi.fn(),
    driveRead: vi.fn(),
    driveWrite: vi.fn().mockResolvedValue({ file_id: 'new-id', name: 'scan-state.json', mime_type: 'text/plain', web_view_link: null }),
    driveSearch: vi.fn(),
    driveCreateFolder: vi.fn(),
    driveList: vi.fn(),
    ...overrides,
  };
}

const sampleState: ScanState = {
  last_seed: '2026-04-02T00:00:00Z',
  topics: {
    travel: {
      last_scan: '2026-04-14T03:00:00Z',
      gmail_after: '2026-04-07',
      pending_deltas: 3,
    },
    work: {
      last_scan: '2026-04-14T03:00:00Z',
      gmail_after: '2026-04-07',
      pending_deltas: 1,
    },
  },
  next_compaction: '2026-05-01',
};

describe('readScanState', () => {
  it('returns default state when no file exists', async () => {
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({ files: [] }),
    });
    const state = await readScanState(client, 'meta-id');
    expect(state).toEqual({ last_seed: '', topics: {}, next_compaction: '' });
  });

  it('reads and parses existing state', async () => {
    const client = mockClient({
      driveList: vi.fn().mockResolvedValue({
        files: [{ file_id: 'state-id', name: 'scan-state.json', mime_type: 'text/plain', size_bytes: 200, modified_at: '2026-04-14T03:00:00Z', web_view_link: null }],
      }),
      driveRead: vi.fn().mockResolvedValue({
        name: 'scan-state.json',
        mime_type: 'text/plain',
        content: JSON.stringify(sampleState),
      }),
    });
    const state = await readScanState(client, 'meta-id');
    expect(state).toEqual(sampleState);
  });

  it('returns default state on error', async () => {
    const client = mockClient({
      driveList: vi.fn().mockRejectedValue(new Error('network')),
    });
    const state = await readScanState(client, 'meta-id');
    expect(state.last_seed).toBe('');
  });
});

describe('writeScanState', () => {
  it('writes state to Drive', async () => {
    const client = mockClient();
    await writeScanState(client, 'meta-id', sampleState);
    expect(client.driveWrite).toHaveBeenCalledWith(
      'scan-state.json',
      JSON.stringify(sampleState, null, 2),
      'text',
      'meta-id',
    );
  });
});

describe('updateTopicScanState', () => {
  it('adds a new topic', () => {
    const state: ScanState = { last_seed: '2026-04-02T00:00:00Z', topics: {}, next_compaction: '2026-05-01' };
    const updated = updateTopicScanState(state, 'travel', {
      topic: 'travel',
      scanEndDate: '2026-04-14',
      itemCount: 5,
    });
    expect(updated.topics.travel).toBeDefined();
    expect(updated.topics.travel!.gmail_after).toBe('2026-04-14');
    expect(updated.topics.travel!.pending_deltas).toBe(1);
  });

  it('increments pending_deltas for existing topic', () => {
    const updated = updateTopicScanState(sampleState, 'travel', {
      topic: 'travel',
      scanEndDate: '2026-04-20',
      itemCount: 3,
    });
    expect(updated.topics.travel!.pending_deltas).toBe(4); // was 3, +1
    expect(updated.topics.travel!.gmail_after).toBe('2026-04-20');
  });

  it('does not mutate the input state', () => {
    const original = JSON.parse(JSON.stringify(sampleState));
    updateTopicScanState(sampleState, 'travel', {
      topic: 'travel',
      scanEndDate: '2026-04-20',
      itemCount: 3,
    });
    expect(sampleState).toEqual(original);
  });
});
