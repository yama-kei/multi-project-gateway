import { describe, it, expect } from 'vitest';
import { chunkMessage } from '../src/discord.js';

describe('chunkMessage', () => {
  it('returns a single chunk for short messages', () => {
    const chunks = chunkMessage('Hello world', 2000);
    expect(chunks).toEqual(['Hello world']);
  });

  it('splits at newline boundaries', () => {
    const line = 'A'.repeat(1500);
    const msg = `${line}\n${'B'.repeat(1500)}`;
    const chunks = chunkMessage(msg, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line);
    expect(chunks[1]).toBe('B'.repeat(1500));
  });

  it('force-splits lines longer than the limit', () => {
    const msg = 'A'.repeat(4500);
    const chunks = chunkMessage(msg, 2000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2000);
    expect(chunks[1]).toHaveLength(2000);
    expect(chunks[2]).toHaveLength(500);
  });

  it('handles empty string', () => {
    expect(chunkMessage('', 2000)).toEqual(['']);
  });
});
