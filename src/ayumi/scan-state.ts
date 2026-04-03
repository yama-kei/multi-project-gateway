/**
 * Manages scan state for the continuous curation lifecycle.
 * State is persisted as `_meta/scan-state.json` on Drive.
 */

import type { BrokerClient } from '../broker-client.js';
import type { TopicName } from './life-context-setup.js';

export interface TopicScanState {
  last_scan: string;       // ISO timestamp of last scan completion
  gmail_after: string;     // date string (YYYY-MM-DD) — scan from here next time
  pending_deltas: number;  // count of uncompacted delta files
}

export interface ScanState {
  last_seed: string;                              // ISO timestamp of last seed run
  topics: Partial<Record<TopicName, TopicScanState>>;
  next_compaction: string;                        // ISO date for next compaction
}

const SCAN_STATE_NAME = 'scan-state.json';

function defaultScanState(): ScanState {
  return {
    last_seed: '',
    topics: {},
    next_compaction: '',
  };
}

/**
 * Read scan state from Drive. Returns default state if missing.
 */
export async function readScanState(
  client: BrokerClient,
  metaFolderId: string,
): Promise<ScanState> {
  try {
    const listing = await client.driveList(metaFolderId, SCAN_STATE_NAME);
    const file = listing.files.find((f) => f.name === SCAN_STATE_NAME);
    if (!file) return defaultScanState();
    const content = await client.driveRead(file.file_id);
    return JSON.parse(content.content) as ScanState;
  } catch {
    return defaultScanState();
  }
}

/**
 * Write scan state to Drive.
 */
export async function writeScanState(
  client: BrokerClient,
  metaFolderId: string,
  state: ScanState,
): Promise<void> {
  await client.driveWrite(
    SCAN_STATE_NAME,
    JSON.stringify(state, null, 2),
    'text',
    metaFolderId,
  );
}

export interface TopicScanResult {
  topic: TopicName;
  scanEndDate: string;  // YYYY-MM-DD — becomes the new gmail_after watermark
  itemCount: number;
}

/**
 * Update a single topic's watermarks after a sync.
 * Returns a new ScanState (does not mutate the input).
 */
export function updateTopicScanState(
  state: ScanState,
  topic: TopicName,
  scanResult: TopicScanResult,
): ScanState {
  const existingTopic = state.topics[topic];
  const pendingDeltas = (existingTopic?.pending_deltas ?? 0) + 1;

  return {
    ...state,
    topics: {
      ...state.topics,
      [topic]: {
        last_scan: new Date().toISOString(),
        gmail_after: scanResult.scanEndDate,
        pending_deltas: pendingDeltas,
      },
    },
  };
}
