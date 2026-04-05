import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseFrontmatter,
  extractTitle,
  extractDate,
  readAndClassifyLocalFiles,
  resolveLocalDir,
} from '../../src/ayumi/local-reader.js';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter and returns fields + body', () => {
    const content = '---\ntitle: My Post\ndate: 2026-03-15\n---\n# My Post\n\nContent here.';
    const result = parseFrontmatter(content);
    expect(result.fields.title).toBe('My Post');
    expect(result.fields.date).toBe('2026-03-15');
    expect(result.body).toContain('# My Post');
    expect(result.body).toContain('Content here.');
  });

  it('returns empty fields and full body when no frontmatter', () => {
    const content = '# No Frontmatter\n\nJust content.';
    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe(content);
  });

  it('strips quotes from field values', () => {
    const content = '---\ntitle: "Quoted Title"\ndate: \'2026-01-01\'\n---\nBody';
    const result = parseFrontmatter(content);
    expect(result.fields.title).toBe('Quoted Title');
    expect(result.fields.date).toBe('2026-01-01');
  });
});

describe('extractTitle', () => {
  it('uses frontmatter title', () => {
    expect(extractTitle('---\ntitle: FM Title\n---\n# H1 Title\nBody', 'file.md')).toBe('FM Title');
  });

  it('falls back to first heading', () => {
    expect(extractTitle('# Heading Title\nBody', 'file.md')).toBe('Heading Title');
  });

  it('falls back to filename', () => {
    expect(extractTitle('Just body text', 'my-cool-post.md')).toBe('my cool post');
  });
});

describe('extractDate', () => {
  it('uses frontmatter date', () => {
    expect(extractDate('---\ndate: 2026-03-15\n---\nBody', 'file.md', new Date('2026-04-01')))
      .toBe('2026-03-15');
  });

  it('extracts date from filename', () => {
    const mtime = new Date('2026-04-01');
    expect(extractDate('No frontmatter', '2026-02-20-my-post.md', mtime))
      .toBe('2026-02-20T00:00:00Z');
  });

  it('falls back to mtime', () => {
    const mtime = new Date('2026-04-01T12:00:00Z');
    expect(extractDate('No date anywhere', 'untitled.md', mtime))
      .toBe('2026-04-01T12:00:00.000Z');
  });
});

describe('readAndClassifyLocalFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'local-reader-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads .md files and classifies them', async () => {
    await writeFile(
      join(tempDir, 'tokyo-trip.md'),
      '---\ntitle: My Tokyo Trip\ndate: 2026-02-15\n---\n# My Tokyo Trip\n\nI traveled to Tokyo and stayed at a hotel near the airport.',
    );

    const result = await readAndClassifyLocalFiles(tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('local');
    expect(result[0].subject).toBe('My Tokyo Trip');
    expect(result[0].topic).toBe('travel');
    expect(result[0].date).toBe('2026-02-15');
    expect(result[0].body).toContain('traveled to Tokyo');
    expect(result[0].from).toContain('tokyo-trip.md');
  });

  it('reads multiple files', async () => {
    await writeFile(join(tempDir, 'work.md'), '# Sprint Planning\n\nMeeting about the project.');
    await writeFile(join(tempDir, 'hobby.md'), '# Weekend Hiking\n\nWent hiking in the mountains with yoga.');

    const result = await readAndClassifyLocalFiles(tempDir);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.source)).toEqual(['local', 'local']);
  });

  it('skips non-.md files', async () => {
    await writeFile(join(tempDir, 'notes.md'), '# Notes\n\nSome notes.');
    await writeFile(join(tempDir, 'image.png'), 'binary data');
    await writeFile(join(tempDir, 'data.json'), '{}');

    const result = await readAndClassifyLocalFiles(tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('Notes');
  });

  it('returns empty array for non-existent directory', async () => {
    const result = await readAndClassifyLocalFiles('/nonexistent/dir/path');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty directory', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'empty-'));
    const result = await readAndClassifyLocalFiles(emptyDir);
    expect(result).toEqual([]);
    await rm(emptyDir, { recursive: true, force: true });
  });

  it('extracts snippet from body without heading', async () => {
    await writeFile(
      join(tempDir, 'post.md'),
      '# Title\n\nThis is the actual content that should become the snippet. It goes on for a while.',
    );

    const result = await readAndClassifyLocalFiles(tempDir);
    expect(result[0].snippet).toBe('This is the actual content that should become the snippet. It goes on for a while.');
  });
});

describe('resolveLocalDir', () => {
  it('returns explicit path', () => {
    expect(resolveLocalDir('/my/dir')).toBe('/my/dir');
  });

  it('reads CURATOR_LOCAL_DIR env var', () => {
    process.env.CURATOR_LOCAL_DIR = '/env/dir';
    expect(resolveLocalDir()).toBe('/env/dir');
    delete process.env.CURATOR_LOCAL_DIR;
  });

  it('returns null when nothing configured', () => {
    delete process.env.CURATOR_LOCAL_DIR;
    expect(resolveLocalDir()).toBeNull();
  });
});
