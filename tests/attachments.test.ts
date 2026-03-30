import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { Collection } from 'discord.js';
import { downloadAttachments, buildAttachmentPrompt, cleanupAttachments, reconcileAttachments, DEFAULT_ATTACHMENT_CONFIG, type AttachmentConfig } from '../src/attachments.js';

const TEST_DIR = join(import.meta.dirname ?? __dirname, '.tmp-attachments-test');

function makeAttachment(overrides: Partial<{ id: string; name: string; size: number; contentType: string | null; url: string }> = {}) {
  return {
    id: overrides.id ?? '1',
    name: overrides.name ?? 'test.png',
    size: overrides.size ?? 1024,
    contentType: 'contentType' in overrides ? overrides.contentType : 'image/png',
    url: overrides.url ?? 'https://cdn.discordapp.com/attachments/test.png',
  } as any;
}

function makeCollection(...items: ReturnType<typeof makeAttachment>[]) {
  const col = new Collection<string, any>();
  for (const item of items) {
    col.set(item.id, item);
  }
  return col;
}

describe('buildAttachmentPrompt', () => {
  it('returns empty string for no attachments', () => {
    expect(buildAttachmentPrompt([])).toBe('');
  });

  it('formats single attachment', () => {
    const result = buildAttachmentPrompt([{ path: '/tmp/file.png', name: 'file.png' }]);
    expect(result).toBe('[Attached files — use the Read tool to view these:\n  /tmp/file.png]\n\n');
  });

  it('formats multiple attachments', () => {
    const result = buildAttachmentPrompt([
      { path: '/tmp/a.png', name: 'a.png' },
      { path: '/tmp/b.pdf', name: 'b.pdf' },
    ]);
    expect(result).toBe('[Attached files — use the Read tool to view these:\n  /tmp/a.png\n  /tmp/b.pdf]\n\n');
  });
});

describe('downloadAttachments', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('skips attachments exceeding size limit', async () => {
    const config: AttachmentConfig = { ...DEFAULT_ATTACHMENT_CONFIG, maxAttachmentSizeMb: 1 };
    const col = makeCollection(makeAttachment({ size: 2 * 1024 * 1024 }));
    const result = await downloadAttachments(col, 'msg1', TEST_DIR, config);
    expect(result.downloaded).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('exceeds');
  });

  it('skips attachments with disallowed mime types', async () => {
    const col = makeCollection(makeAttachment({ contentType: 'application/zip' }));
    const result = await downloadAttachments(col, 'msg2', TEST_DIR, DEFAULT_ATTACHMENT_CONFIG);
    expect(result.downloaded).toHaveLength(0);
    expect(result.warnings[0]).toContain('not allowed');
  });

  it('enforces max attachments per message', async () => {
    const config: AttachmentConfig = { ...DEFAULT_ATTACHMENT_CONFIG, maxAttachmentsPerMessage: 2 };
    const items = [
      makeAttachment({ id: '1', name: 'a.png' }),
      makeAttachment({ id: '2', name: 'b.png' }),
      makeAttachment({ id: '3', name: 'c.png' }),
    ];
    // Mock fetch for all — only first 2 should be processed
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    }));
    const col = makeCollection(...items);
    const result = await downloadAttachments(col, 'msg3', TEST_DIR, config);
    expect(result.downloaded).toHaveLength(2);
    expect(result.warnings[0]).toContain('Only processing first 2');
  });

  it('downloads valid attachments to disk', async () => {
    const content = Buffer.from('hello world');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength)),
    }));
    const col = makeCollection(makeAttachment({ name: 'readme.txt', contentType: 'text/plain' }));
    const result = await downloadAttachments(col, 'msg4', TEST_DIR, DEFAULT_ATTACHMENT_CONFIG);
    expect(result.downloaded).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
    const filePath = result.downloaded[0].path;
    expect(filePath).toBe(join(TEST_DIR, '.mpg-attachments', 'msg4', 'readme.txt'));
    expect(existsSync(filePath)).toBe(true);
  });

  it('handles fetch failures gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const col = makeCollection(makeAttachment());
    const result = await downloadAttachments(col, 'msg5', TEST_DIR, DEFAULT_ATTACHMENT_CONFIG);
    expect(result.downloaded).toHaveLength(0);
    expect(result.warnings[0]).toContain('HTTP 403');
  });

  it('allows wildcard mime types', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }));
    const col = makeCollection(makeAttachment({ contentType: 'image/jpeg', name: 'photo.jpg' }));
    const result = await downloadAttachments(col, 'msg6', TEST_DIR, DEFAULT_ATTACHMENT_CONFIG);
    expect(result.downloaded).toHaveLength(1);
  });

  it('allows application/json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }));
    const col = makeCollection(makeAttachment({ contentType: 'application/json', name: 'data.json' }));
    const result = await downloadAttachments(col, 'msg7', TEST_DIR, DEFAULT_ATTACHMENT_CONFIG);
    expect(result.downloaded).toHaveLength(1);
  });

  it('sanitizes path traversal in filenames', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }));
    const col = makeCollection(makeAttachment({ name: '../../.env', contentType: 'text/plain' }));
    const result = await downloadAttachments(col, 'msg-traversal', TEST_DIR, DEFAULT_ATTACHMENT_CONFIG);
    // Should still download but with sanitized filename (basename strips ../)
    expect(result.downloaded).toHaveLength(1);
    expect(result.downloaded[0].name).toBe('env');
    expect(result.downloaded[0].path).toBe(join(TEST_DIR, '.mpg-attachments', 'msg-traversal', 'env'));
  });

  it('rejects attachments from untrusted URL hosts', async () => {
    const col = makeCollection(makeAttachment({ url: 'http://internal-server.local/secret.txt', contentType: 'text/plain' }));
    const result = await downloadAttachments(col, 'msg-ssrf', TEST_DIR, DEFAULT_ATTACHMENT_CONFIG);
    expect(result.downloaded).toHaveLength(0);
    expect(result.warnings[0]).toContain('untrusted URL host');
  });

  it('rejects null content type', async () => {
    const col = makeCollection(makeAttachment({ contentType: null as any, name: 'mystery.bin' }));
    const result = await downloadAttachments(col, 'msg8', TEST_DIR, DEFAULT_ATTACHMENT_CONFIG);
    expect(result.downloaded).toHaveLength(0);
    expect(result.warnings[0]).toContain('not allowed');
  });
});

describe('cleanupAttachments', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('removes the .mpg-attachments directory', async () => {
    const dir = join(TEST_DIR, '.mpg-attachments', 'msg1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'test.txt'), 'hello');
    await cleanupAttachments(TEST_DIR);
    expect(existsSync(join(TEST_DIR, '.mpg-attachments'))).toBe(false);
  });

  it('does not throw if directory does not exist', async () => {
    await expect(cleanupAttachments(join(TEST_DIR, 'nonexistent'))).resolves.toBeUndefined();
  });
});

describe('reconcileAttachments', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('removes orphaned .mpg-attachments directory and returns true', async () => {
    const dir = join(TEST_DIR, '.mpg-attachments', 'old-msg');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'file.txt'), 'orphan');
    const removed = await reconcileAttachments(TEST_DIR);
    expect(removed).toBe(true);
    expect(existsSync(join(TEST_DIR, '.mpg-attachments'))).toBe(false);
  });

  it('returns false when no .mpg-attachments directory exists', async () => {
    const removed = await reconcileAttachments(TEST_DIR);
    expect(removed).toBe(false);
  });
});

describe('DEFAULT_ATTACHMENT_CONFIG', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_ATTACHMENT_CONFIG.maxAttachmentSizeMb).toBe(10);
    expect(DEFAULT_ATTACHMENT_CONFIG.maxAttachmentsPerMessage).toBe(5);
    expect(DEFAULT_ATTACHMENT_CONFIG.allowedMimeTypes).toContain('image/*');
    expect(DEFAULT_ATTACHMENT_CONFIG.allowedMimeTypes).toContain('application/pdf');
  });
});
