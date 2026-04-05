import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractTitle,
  extractDate,
  extractBody,
  stripTags,
  parseUrlList,
  fetchAndClassifyUrls,
  loadUrlSources,
} from '../../src/ayumi/web-fetcher.js';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('extractTitle', () => {
  it('extracts from <title> tag', () => {
    const html = '<html><head><title>My Article Title</title></head><body></body></html>';
    expect(extractTitle(html)).toBe('My Article Title');
  });

  it('falls back to <h1>', () => {
    const html = '<html><body><h1>Heading Title</h1><p>Content</p></body></html>';
    expect(extractTitle(html)).toBe('Heading Title');
  });

  it('returns Untitled when no title found', () => {
    const html = '<html><body><p>Just content</p></body></html>';
    expect(extractTitle(html)).toBe('Untitled');
  });

  it('strips tags inside <h1>', () => {
    const html = '<html><body><h1><span>Rich</span> Title</h1></body></html>';
    expect(extractTitle(html)).toBe('Rich Title');
  });
});

describe('extractDate', () => {
  it('extracts from article:published_time meta tag', () => {
    const html = '<meta property="article:published_time" content="2026-03-15T10:00:00Z">';
    expect(extractDate(html)).toBe('2026-03-15T10:00:00Z');
  });

  it('extracts from <time datetime="">', () => {
    const html = '<time datetime="2026-01-20T09:00:00+09:00">Jan 20</time>';
    expect(extractDate(html)).toBe('2026-01-20T09:00:00+09:00');
  });

  it('returns null when no date found', () => {
    const html = '<html><body><p>No dates here</p></body></html>';
    expect(extractDate(html)).toBeNull();
  });
});

describe('extractBody', () => {
  it('extracts from <article> tag', () => {
    const html = '<html><body><nav>nav</nav><article><p>Article content</p></article><footer>foot</footer></body></html>';
    expect(extractBody(html)).toBe('Article content');
  });

  it('falls back to <main> tag', () => {
    const html = '<html><body><main><p>Main content here</p></main></body></html>';
    expect(extractBody(html)).toBe('Main content here');
  });

  it('falls back to <body> tag', () => {
    const html = '<html><body><p>Body content only</p></body></html>';
    expect(extractBody(html)).toBe('Body content only');
  });
});

describe('stripTags', () => {
  it('removes HTML tags', () => {
    expect(stripTags('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('removes script and style tags', () => {
    expect(stripTags('<script>alert("x")</script><style>body{}</style><p>Text</p>')).toBe('Text');
  });

  it('decodes HTML entities', () => {
    expect(stripTags('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'');
  });
});

describe('parseUrlList', () => {
  it('parses plain URLs', () => {
    const content = 'https://example.com/a\nhttps://example.com/b\n';
    expect(parseUrlList(content)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('parses markdown list format', () => {
    const content = '- https://example.com/a\n- https://example.com/b\n* https://example.com/c\n';
    expect(parseUrlList(content)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });

  it('skips non-URL lines', () => {
    const content = '# My URLs\n\nSome description\n- https://example.com/a\n- not a url\n';
    expect(parseUrlList(content)).toEqual(['https://example.com/a']);
  });
});

describe('loadUrlSources', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-fetcher-test-'));
    delete process.env.CURATOR_URLS;
  });

  afterEach(async () => {
    delete process.env.CURATOR_URLS;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns explicit URLs when provided', async () => {
    const result = await loadUrlSources(['https://a.com', 'https://b.com']);
    expect(result).toEqual(['https://a.com', 'https://b.com']);
  });

  it('reads from CURATOR_URLS env var', async () => {
    process.env.CURATOR_URLS = 'https://a.com,https://b.com';
    const result = await loadUrlSources();
    expect(result).toEqual(['https://a.com', 'https://b.com']);
  });

  it('reads from vault _identity/authored-sources.md', async () => {
    await mkdir(join(tempDir, '_identity'), { recursive: true });
    await writeFile(
      join(tempDir, '_identity', 'authored-sources.md'),
      '# Sources\n\n- https://blog.example.com/post-1\n- https://blog.example.com/post-2\n',
    );
    const result = await loadUrlSources(undefined, tempDir);
    expect(result).toEqual([
      'https://blog.example.com/post-1',
      'https://blog.example.com/post-2',
    ]);
  });

  it('returns empty when no sources configured', async () => {
    const result = await loadUrlSources();
    expect(result).toEqual([]);
  });
});

describe('fetchAndClassifyUrls', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches URLs and returns classified items', async () => {
    const mockHtml = `
      <html>
      <head><title>My Travel Blog Post</title></head>
      <body>
        <article>
          <p>I went on a trip to Tokyo. The hotel was amazing and the flight was smooth.</p>
        </article>
      </body>
      </html>
    `;

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await fetchAndClassifyUrls(['https://blog.example.com/tokyo-trip']);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('web');
    expect(result[0].subject).toBe('My Travel Blog Post');
    expect(result[0].topic).toBe('travel');
    expect(result[0].from).toBe('https://blog.example.com/tokyo-trip');
    expect(result[0].body).toContain('trip to Tokyo');
  });

  it('skips URLs that fail to fetch', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('<html><head><title>Good</title></head><body><article>Content</article></body></html>'),
      });

    const result = await fetchAndClassifyUrls([
      'https://bad.example.com/broken',
      'https://good.example.com/works',
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('Good');
  });

  it('handles HTTP errors gracefully', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await fetchAndClassifyUrls(['https://example.com/missing']);
    expect(result).toHaveLength(0);
  });
});
