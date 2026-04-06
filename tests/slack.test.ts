import { describe, it, expect } from 'vitest';
import { chunkSlackMessage } from '../src/slack.js';

describe('chunkSlackMessage', () => {
  it('returns single chunk for short text', () => {
    const result = chunkSlackMessage('hello world', 100);
    expect(result).toEqual(['hello world']);
  });

  it('chunks text at line boundaries', () => {
    const lines = ['line 1', 'line 2', 'line 3', 'line 4'];
    const text = lines.join('\n');
    // Limit that forces a split after "line 1\nline 2"
    const result = chunkSlackMessage(text, 14);
    expect(result).toEqual(['line 1\nline 2', 'line 3\nline 4']);
  });

  it('handles lines longer than limit', () => {
    const longLine = 'a'.repeat(20);
    const result = chunkSlackMessage(longLine, 8);
    expect(result).toEqual(['aaaaaaaa', 'aaaaaaaa', 'aaaa']);
  });

  it('handles empty text', () => {
    const result = chunkSlackMessage('', 100);
    expect(result).toEqual(['']);
  });

  it('uses default Slack limit (~3900)', () => {
    const short = 'hello';
    const result = chunkSlackMessage(short);
    expect(result).toEqual(['hello']);
  });

  it('splits at 3900 char default limit', () => {
    const text = 'a'.repeat(4000);
    const result = chunkSlackMessage(text);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(3900);
    expect(result[1].length).toBe(100);
  });

  it('preserves line breaks in chunks', () => {
    const text = 'line1\nline2\nline3';
    const result = chunkSlackMessage(text, 12);
    expect(result).toEqual(['line1\nline2', 'line3']);
  });
});

describe('SlackBot interface', () => {
  it('exports createSlackBot function', async () => {
    const mod = await import('../src/slack.js');
    expect(mod.createSlackBot).toBeTypeOf('function');
  });
});
