# Ayumi Broker Client — MPG Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a broker client module to MPG that lets agents call HouseholdOS's credential broker API, and an idempotent Drive setup routine that ensures the `/life-context/` folder structure exists.

**Architecture:** A standalone `broker-client.ts` module wraps all broker HTTP calls behind typed functions. A `life-context-setup.ts` module uses the broker client to idempotently create the Drive folder tree (`/life-context/{topic}/_meta/`). Both modules are pure library code — no MPG framework changes needed. Config is loaded from environment variables (`BROKER_URL`, `BROKER_API_SECRET`, `BROKER_TENANT_ID`, `BROKER_ACTOR_ID`).

**Tech Stack:** TypeScript, native `fetch` (Node 20+), Vitest for testing. No new dependencies.

**Broker API Reference (HouseholdOS):**
All endpoints require `X-Broker-Secret` header and POST JSON body with `tenantId` + `actorId`.

| Endpoint | Body (beyond tenant/actor) | Returns |
|----------|---------------------------|---------|
| `GET /broker/health` | — | `{ ok: true }` |
| `POST /broker/gmail/search` | `q, maxResults?, pageToken?` | `{ messages, nextPageToken? }` |
| `POST /broker/gmail/messages` | `messageIds` (max 50) | `{ messages }` |
| `POST /broker/calendar/events` | `timeMin, timeMax, limit?` | `{ events }` |
| `POST /broker/drive/read` | `fileId` | `{ name, mime_type, content }` |
| `POST /broker/drive/write` | `name, content, format?` | `{ file_id, name, mime_type, web_view_link }` |
| `POST /broker/drive/search` | `query` | `{ files }` |
| `POST /broker/drive/create-folder` | `name, parentId?` | `{ folder_id, name, web_view_link }` |
| `POST /broker/drive/list` | `folderId, query?` | `{ files }` |

---

### Task 1: Broker Client Module

**Files:**
- Create: `src/broker-client.ts`
- Create: `tests/broker-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/broker-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBrokerClient, type BrokerClient } from '../src/broker-client.js';

describe('BrokerClient', () => {
  let client: BrokerClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = createBrokerClient({
      brokerUrl: 'http://localhost:3000',
      apiSecret: 'test-secret',
      tenantId: 'tenant-1',
      actorId: 'actor-1',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('health check calls GET /broker/health with secret header', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await client.health();

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/broker/health',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-Broker-Secret': 'test-secret' }),
      }),
    );
  });

  it('gmailSearch calls POST /broker/gmail/search', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'msg1' }], nextPageToken: 'p2' }), { status: 200 }),
    );

    const result = await client.gmailSearch('from:alice@example.com', 10);

    expect(result.messages).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/broker/gmail/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tenantId: 'tenant-1', actorId: 'actor-1', q: 'from:alice@example.com', maxResults: 10 }),
      }),
    );
  });

  it('gmailMessages calls POST /broker/gmail/messages', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'msg1', body: 'hello' }] }), { status: 200 }),
    );

    const result = await client.gmailMessages(['msg1']);

    expect(result.messages).toHaveLength(1);
  });

  it('calendarEvents calls POST /broker/calendar/events', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ events: [{ id: 'evt1', title: 'Standup' }] }), { status: 200 }),
    );

    const result = await client.calendarEvents('2026-01-01T00:00:00Z', '2026-01-31T23:59:59Z');

    expect(result.events).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/broker/calendar/events',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('timeMin'),
      }),
    );
  });

  it('driveRead calls POST /broker/drive/read', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ name: 'file.md', mime_type: 'text/plain', content: '# Hello' }), { status: 200 }),
    );

    const result = await client.driveRead('file-id-123');

    expect(result.content).toBe('# Hello');
  });

  it('driveWrite calls POST /broker/drive/write', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ file_id: 'new-id', name: 'out.md', mime_type: 'text/plain', web_view_link: null }), { status: 200 }),
    );

    const result = await client.driveWrite('out.md', '# Content', 'text');

    expect(result.file_id).toBe('new-id');
  });

  it('driveSearch calls POST /broker/drive/search', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ files: [{ file_id: 'f1', name: 'notes.md' }] }), { status: 200 }),
    );

    const result = await client.driveSearch('notes');

    expect(result.files).toHaveLength(1);
  });

  it('driveCreateFolder calls POST /broker/drive/create-folder', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ folder_id: 'fold-1', name: 'work', web_view_link: null }), { status: 200 }),
    );

    const result = await client.driveCreateFolder('work', 'parent-id');

    expect(result.folder_id).toBe('fold-1');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/broker/drive/create-folder',
      expect.objectContaining({
        body: JSON.stringify({ tenantId: 'tenant-1', actorId: 'actor-1', name: 'work', parentId: 'parent-id' }),
      }),
    );
  });

  it('driveList calls POST /broker/drive/list', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ files: [{ file_id: 'f1', name: 'sub', mime_type: 'application/vnd.google-apps.folder' }] }), { status: 200 }),
    );

    const result = await client.driveList('folder-id');

    expect(result.files).toHaveLength(1);
  });

  it('throws BrokerError on 401 response', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));

    await expect(client.health()).rejects.toThrow('Broker API error (401)');
  });

  it('throws BrokerError on 500 response', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 }));

    await expect(client.gmailSearch('test')).rejects.toThrow('Broker API error (500)');
  });

  it('throws on network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.health()).rejects.toThrow('ECONNREFUSED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Documents/multi-project-gateway && npx vitest run tests/broker-client.test.ts`
Expected: FAIL — module `broker-client` not found

- [ ] **Step 3: Write the broker client**

Create `src/broker-client.ts`:

```typescript
/**
 * Typed HTTP client for the HouseholdOS credential broker API.
 * Used by Ayumi agents to access Gmail, Calendar, and Drive
 * without handling raw OAuth tokens.
 */

export interface BrokerConfig {
  brokerUrl: string;
  apiSecret: string;
  tenantId: string;
  actorId: string;
}

export class BrokerError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`Broker API error (${status})`);
    this.name = 'BrokerError';
  }
}

// --- Response types ---

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labelIds: string[];
  hasAttachments: boolean;
}

export interface GmailMessageFull extends GmailMessage {
  body: string;
  bodyHtml: string;
}

export interface GmailSearchResult {
  messages: GmailMessage[];
  nextPageToken?: string;
}

export interface GmailMessagesResult {
  messages: GmailMessageFull[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
  organizer_email: string | null;
  status: string;
}

export interface CalendarEventsResult {
  events: CalendarEvent[];
}

export interface DriveFile {
  file_id: string;
  name: string;
  mime_type: string;
  size_bytes: number | null;
  modified_at: string;
  web_view_link: string | null;
}

export interface DriveReadResult {
  name: string;
  mime_type: string;
  content: string;
}

export interface DriveWriteResult {
  file_id: string;
  name: string;
  mime_type: string;
  web_view_link: string | null;
}

export interface DriveSearchResult {
  files: DriveFile[];
}

export interface DriveCreateFolderResult {
  folder_id: string;
  name: string;
  web_view_link: string | null;
}

export interface DriveListResult {
  files: DriveFile[];
}

export interface BrokerClient {
  health(): Promise<{ ok: boolean }>;
  gmailSearch(q: string, maxResults?: number, pageToken?: string): Promise<GmailSearchResult>;
  gmailMessages(messageIds: string[]): Promise<GmailMessagesResult>;
  calendarEvents(timeMin: string, timeMax: string, limit?: number): Promise<CalendarEventsResult>;
  driveRead(fileId: string): Promise<DriveReadResult>;
  driveWrite(name: string, content: string, format?: string): Promise<DriveWriteResult>;
  driveSearch(query: string): Promise<DriveSearchResult>;
  driveCreateFolder(name: string, parentId?: string): Promise<DriveCreateFolderResult>;
  driveList(folderId: string, query?: string): Promise<DriveListResult>;
}

export function createBrokerClient(config: BrokerConfig): BrokerClient {
  const { brokerUrl, apiSecret, tenantId, actorId } = config;
  const base = brokerUrl.replace(/\/$/, '');

  async function request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${base}/broker${path}`;
    const headers: Record<string, string> = {
      'X-Broker-Secret': apiSecret,
    };
    const init: RequestInit = { method, headers };

    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify({ tenantId, actorId, ...body });
    }

    const res = await fetch(url, init);
    const json = await res.json();

    if (!res.ok) {
      throw new BrokerError(res.status, json);
    }

    return json as T;
  }

  return {
    health: () => request('GET', '/health'),
    gmailSearch: (q, maxResults, pageToken) =>
      request('POST', '/gmail/search', { q, maxResults, pageToken }),
    gmailMessages: (messageIds) =>
      request('POST', '/gmail/messages', { messageIds }),
    calendarEvents: (timeMin, timeMax, limit) =>
      request('POST', '/calendar/events', { timeMin, timeMax, limit }),
    driveRead: (fileId) =>
      request('POST', '/drive/read', { fileId }),
    driveWrite: (name, content, format) =>
      request('POST', '/drive/write', { name, content, format }),
    driveSearch: (query) =>
      request('POST', '/drive/search', { query }),
    driveCreateFolder: (name, parentId) =>
      request('POST', '/drive/create-folder', { name, parentId }),
    driveList: (folderId, query) =>
      request('POST', '/drive/list', { folderId, query }),
  };
}

/**
 * Create a broker client from environment variables.
 * Required: BROKER_URL, BROKER_API_SECRET, BROKER_TENANT_ID, BROKER_ACTOR_ID
 */
export function createBrokerClientFromEnv(): BrokerClient {
  const brokerUrl = process.env.BROKER_URL;
  const apiSecret = process.env.BROKER_API_SECRET;
  const tenantId = process.env.BROKER_TENANT_ID;
  const actorId = process.env.BROKER_ACTOR_ID;

  if (!brokerUrl || !apiSecret || !tenantId || !actorId) {
    throw new Error(
      'Missing broker env vars. Required: BROKER_URL, BROKER_API_SECRET, BROKER_TENANT_ID, BROKER_ACTOR_ID',
    );
  }

  return createBrokerClient({ brokerUrl, apiSecret, tenantId, actorId });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Documents/multi-project-gateway && npx vitest run tests/broker-client.test.ts`
Expected: PASS — all 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/broker-client.ts tests/broker-client.test.ts
git commit -m "feat(ayumi): add broker client module for HouseholdOS credential broker"
```

---

### Task 2: Life Context Drive Setup

An idempotent routine that ensures the `/life-context/` folder tree exists in Google Drive. It searches for existing folders by name before creating, and stores folder IDs in a `_meta/folder-map.json` file in Drive for subsequent lookups.

**Folder structure:**
```
life-context/
├── work/
├── travel/
├── finance/
├── health/
├── social/
├── hobbies/
└── _meta/
    └── folder-map.json
```

**Files:**
- Create: `src/life-context-setup.ts`
- Create: `tests/life-context-setup.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/life-context-setup.test.ts`:

```typescript
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
      expect.stringContaining('"root":"root-id"'),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Documents/multi-project-gateway && npx vitest run tests/life-context-setup.test.ts`
Expected: FAIL — module `life-context-setup` not found

- [ ] **Step 3: Write the life context setup module**

Create `src/life-context-setup.ts`:

```typescript
/**
 * Idempotent setup for the /life-context/ folder tree in Google Drive.
 * Searches for an existing folder-map.json first; creates any missing folders.
 */

import type { BrokerClient } from './broker-client.js';

export const TOPIC_FOLDERS = ['work', 'travel', 'finance', 'health', 'social', 'hobbies'] as const;
export type TopicName = (typeof TOPIC_FOLDERS)[number];

export interface FolderMap {
  root: string;
  topics: Record<TopicName, string>;
  meta: string;
}

const FOLDER_MAP_NAME = 'folder-map.json';

/**
 * Ensure the life-context folder tree exists in Drive.
 * Returns a FolderMap with all folder IDs.
 *
 * Idempotent: reads existing folder-map.json from Drive if present,
 * creates only missing folders, and writes the updated map back.
 */
export async function ensureLifeContextFolders(client: BrokerClient): Promise<FolderMap> {
  // Step 1: Check for existing folder-map.json
  const existing = await loadExistingMap(client);
  if (existing && isComplete(existing)) {
    return existing;
  }

  // Step 2: Start from existing partial map or build from scratch
  const map: FolderMap = existing ?? {
    root: '',
    topics: { work: '', travel: '', finance: '', health: '', social: '', hobbies: '' },
    meta: '',
  };

  // Step 3: Create root folder if missing
  if (!map.root) {
    const result = await client.driveCreateFolder('life-context');
    map.root = result.folder_id;
  }

  // Step 4: Create topic folders if missing
  for (const topic of TOPIC_FOLDERS) {
    if (!map.topics[topic]) {
      const result = await client.driveCreateFolder(topic, map.root);
      map.topics[topic] = result.folder_id;
    }
  }

  // Step 5: Create _meta folder if missing
  if (!map.meta) {
    const result = await client.driveCreateFolder('_meta', map.root);
    map.meta = result.folder_id;
  }

  // Step 6: Write folder-map.json to _meta
  await client.driveWrite(FOLDER_MAP_NAME, JSON.stringify(map, null, 2), 'text');

  return map;
}

async function loadExistingMap(client: BrokerClient): Promise<FolderMap | null> {
  try {
    const searchResult = await client.driveSearch(FOLDER_MAP_NAME);
    const mapFile = searchResult.files.find((f) => f.name === FOLDER_MAP_NAME);
    if (!mapFile) return null;

    const content = await client.driveRead(mapFile.file_id);
    return JSON.parse(content.content) as FolderMap;
  } catch {
    return null;
  }
}

function isComplete(map: FolderMap): boolean {
  if (!map.root || !map.meta) return false;
  return TOPIC_FOLDERS.every((t) => !!map.topics[t]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Documents/multi-project-gateway && npx vitest run tests/life-context-setup.test.ts`
Expected: PASS — all 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/life-context-setup.ts tests/life-context-setup.test.ts
git commit -m "feat(ayumi): add idempotent life-context Drive folder setup"
```

---

### Task 3: Environment Configuration

**Files:**
- Modify: `.env` (add broker vars)
- Create: `.env.example` (if not present — document all env vars)

- [ ] **Step 1: Add broker env vars to .env**

Append to `.env`:

```
# Ayumi — HouseholdOS credential broker
BROKER_URL=http://localhost:3000
BROKER_API_SECRET=<same value as BROKER_API_SECRET in HouseholdOS .env>
BROKER_TENANT_ID=<tenant UUID from HouseholdOS tenants table>
BROKER_ACTOR_ID=<actor UUID from HouseholdOS actors table>
```

The engineer will need to look up the actual tenant/actor UUIDs from HouseholdOS's database:

```bash
docker exec householdos_postgres psql -U app_api -d householdos \
  -c "select id, name from tenants limit 5;"
docker exec householdos_postgres psql -U app_api -d householdos \
  -c "select id, display_name from actors limit 5;"
```

- [ ] **Step 2: Create .env.example**

Create `.env.example`:

```
# Discord bot token (required for MPG)
DISCORD_BOT_TOKEN=your-discord-bot-token

# Ayumi — HouseholdOS credential broker (optional, only needed for Ayumi agents)
BROKER_URL=http://localhost:3000
BROKER_API_SECRET=your-broker-secret-here
BROKER_TENANT_ID=your-tenant-uuid
BROKER_ACTOR_ID=your-actor-uuid
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "feat(ayumi): add broker env vars to .env.example"
```

Note: Do NOT commit `.env` — it contains secrets. Only commit `.env.example`.

---

### Task 4: Connectivity Test (Manual Verification)

This task verifies the broker client works against a running HouseholdOS instance. No automated test — this is a manual smoke test.

**Prerequisites:**
- HouseholdOS postgres container running: `docker start householdos_postgres`
- HouseholdOS API running: `cd ~/Documents/HouseholdOS/apps/api && npm run dev`
- `.env` populated with correct `BROKER_URL`, `BROKER_API_SECRET`, `BROKER_TENANT_ID`, `BROKER_ACTOR_ID`

- [ ] **Step 1: Write a quick connectivity script**

Create `scripts/test-broker-connectivity.ts`:

```typescript
/**
 * Quick smoke test: verify MPG can reach the HouseholdOS broker.
 * Run: npx tsx scripts/test-broker-connectivity.ts
 */

import { config } from 'dotenv';
config();

import { createBrokerClientFromEnv } from '../src/broker-client.js';

async function main() {
  console.log('Testing broker connectivity...');
  console.log(`  BROKER_URL: ${process.env.BROKER_URL}`);

  const client = createBrokerClientFromEnv();

  // 1. Health check
  const health = await client.health();
  console.log(`  /broker/health: ${health.ok ? 'OK' : 'FAIL'}`);

  // 2. Drive setup
  const { ensureLifeContextFolders } = await import('../src/life-context-setup.js');
  const folders = await ensureLifeContextFolders(client);
  console.log(`  life-context root folder: ${folders.root}`);
  console.log(`  topic folders: ${Object.entries(folders.topics).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  _meta folder: ${folders.meta}`);

  // 3. Test write + read round-trip
  const writeResult = await client.driveWrite('_connectivity-test.txt', `Broker connectivity test at ${new Date().toISOString()}`, 'text');
  console.log(`  drive/write: created ${writeResult.file_id}`);
  const readResult = await client.driveRead(writeResult.file_id);
  console.log(`  drive/read: got "${readResult.content.slice(0, 50)}..."`);

  console.log('\nAll checks passed!');
}

main().catch((err) => {
  console.error('Connectivity test failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run the connectivity test**

```bash
cd ~/Documents/multi-project-gateway && npx tsx scripts/test-broker-connectivity.ts
```

Expected output:
```
Testing broker connectivity...
  BROKER_URL: http://localhost:3000
  /broker/health: OK
  life-context root folder: <uuid>
  topic folders: work=<uuid>, travel=<uuid>, ...
  _meta folder: <uuid>
  drive/write: created <uuid>
  drive/read: got "Broker connectivity test at 2026-..."

All checks passed!
```

- [ ] **Step 3: Commit the script**

```bash
git add scripts/test-broker-connectivity.ts
git commit -m "feat(ayumi): add broker connectivity smoke test script"
```

---

### Task 5: Update Ayumi Issue

- [ ] **Step 1: Update yama-kei/ayumi#2 to check off MPG + Drive tasks**

Run:

```bash
gh issue edit 2 --repo yama-kei/ayumi --body "<updated body with MPG and Drive tasks checked>"
```

The MPG tasks should be checked:
- [x] Configuration for HouseholdOS broker URL + API key
- [x] Test connectivity: agent can call broker and get Gmail/Calendar data

The Drive tasks should be checked:
- [x] Create `/life-context/` folder structure with topic subfolders via broker
- [x] Create `_meta/` folder for scan state and audit logs

- [ ] **Step 2: Commit all, push, create PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(ayumi): broker client + life-context Drive setup" --body "..."
```
