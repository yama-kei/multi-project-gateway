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

  it('driveWrite passes folderId in request body when provided', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ file_id: 'new-id', name: 'out.md', mime_type: 'text/plain', web_view_link: null }), { status: 200 }),
    );

    await client.driveWrite('out.md', '# Content', 'text', 'custom-folder-id');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/broker/drive/write',
      expect.objectContaining({
        body: JSON.stringify({
          tenantId: 'tenant-1',
          actorId: 'actor-1',
          name: 'out.md',
          content: '# Content',
          format: 'text',
          folderId: 'custom-folder-id',
        }),
      }),
    );
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

  it('excludes undefined optional parameters from request body', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ messages: [], nextPageToken: undefined }), { status: 200 }),
    );

    await client.gmailSearch('test query');

    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody).toEqual({
      tenantId: 'tenant-1',
      actorId: 'actor-1',
      q: 'test query',
    });
    expect(callBody).not.toHaveProperty('maxResults');
    expect(callBody).not.toHaveProperty('pageToken');
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
