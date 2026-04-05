/**
 * Fetches and extracts article text from web URLs.
 * Used by the curator agent to ingest authored content (blog posts, articles)
 * when the user provides URLs in chat.
 *
 * Primary interface: fetchUrls(urls) — accepts URLs directly from the agent.
 * Optional: parseUrlList() can parse a markdown file of URLs (e.g. authored-sources.md).
 */

import type { ClassifiedItem } from './extraction-pipeline.js';
import { classifyTopic } from './extraction-pipeline.js';

const TOPIC_TIER_MAP = {
  work: 2, travel: 1, finance: 3, health: 3, social: 2, hobbies: 1,
} as const;

/**
 * Extract article title from HTML.
 * Tries <title>, then first <h1>.
 */
export function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim().replace(/\s+/g, ' ');

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) return stripTags(h1Match[1]).trim();

  return 'Untitled';
}

/**
 * Extract publication date from HTML meta tags.
 * Looks for common meta date patterns.
 */
export function extractDate(html: string): string | null {
  // <meta property="article:published_time" content="...">
  const ogDate = html.match(/<meta\s+(?:property|name)="(?:article:published_time|date|DC\.date|publish[_-]?date)"[^>]*content="([^"]+)"/i);
  if (ogDate) return ogDate[1];

  // <time datetime="...">
  const timeTag = html.match(/<time[^>]*datetime="([^"]+)"/i);
  if (timeTag) return timeTag[1];

  return null;
}

/**
 * Strip HTML tags from a string.
 */
export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract article body text from HTML.
 * Prefers <article> or <main> content, falls back to <body>.
 */
export function extractBody(html: string): string {
  // Try <article> first
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) return stripTags(articleMatch[1]);

  // Try <main>
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return stripTags(mainMatch[1]);

  // Fall back to <body>
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return stripTags(bodyMatch[1]);

  return stripTags(html);
}

/**
 * Parse a markdown file containing URLs (one per line, optionally in a list).
 * Useful for reading $VAULT_PATH/_identity/authored-sources.md.
 */
export function parseUrlList(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.startsWith('http://') || line.startsWith('https://'));
}

export interface WebFetchResult {
  url: string;
  title: string;
  date: string;
  body: string;
  snippet: string;
}

/**
 * Fetch a single URL and extract article content.
 * Uses native fetch (Node 18+).
 */
export async function fetchUrl(url: string): Promise<WebFetchResult> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Ayumi-Curator/1.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const html = await response.text();
  const title = extractTitle(html);
  const rawDate = extractDate(html);
  const date = rawDate ?? new Date().toISOString();
  const body = extractBody(html);
  const snippet = body.slice(0, 200);

  return { url, title, date, body, snippet };
}

/**
 * Fetch multiple URLs and return ClassifiedItems.
 * The agent calls this directly with URLs from user chat.
 * Errors on individual URLs are logged and skipped.
 */
export async function fetchUrls(
  urls: string[],
): Promise<ClassifiedItem[]> {
  const items: ClassifiedItem[] = [];

  for (const url of urls) {
    try {
      const result = await fetchUrl(url);
      const topic = classifyTopic(result.title, result.snippet, url);
      items.push({
        sourceId: url,
        source: 'web',
        topic,
        tier: TOPIC_TIER_MAP[topic],
        subject: result.title,
        date: result.date,
        from: url,
        snippet: result.snippet,
        body: result.body,
      });
    } catch (err) {
      console.warn(`[web-fetcher] Failed to fetch ${url}:`, err);
    }
  }

  return items;
}
