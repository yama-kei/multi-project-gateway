import { describe, it, expect } from 'vitest';
import { NON_INTERACTIVE_CHAT_NUDGE, applyChatNudge } from '../src/chat-nudge.js';

describe('NON_INTERACTIVE_CHAT_NUDGE', () => {
  it('instructs Claude to use plain-text numbered lists instead of menu prompts', () => {
    expect(NON_INTERACTIVE_CHAT_NUDGE).toMatch(/numbered list/i);
    expect(NON_INTERACTIVE_CHAT_NUDGE).toMatch(/plain text/i);
  });

  it('frames the session as non-interactive (so Claude understands menu tools dead-end)', () => {
    expect(NON_INTERACTIVE_CHAT_NUDGE).toMatch(/non-interactive/i);
  });
});

describe('applyChatNudge', () => {
  it('returns the nudge as-is when no system prompt is provided', () => {
    expect(applyChatNudge(undefined)).toBe(NON_INTERACTIVE_CHAT_NUDGE);
  });

  it('returns the nudge as-is when system prompt is empty string', () => {
    expect(applyChatNudge('')).toBe(NON_INTERACTIVE_CHAT_NUDGE);
  });

  it('appends the nudge to a non-empty system prompt with a separator', () => {
    const result = applyChatNudge('You are a PM.');
    expect(result.startsWith('You are a PM.')).toBe(true);
    expect(result.endsWith(NON_INTERACTIVE_CHAT_NUDGE)).toBe(true);
    expect(result).toContain('\n\n');
  });

  it('preserves the original system prompt content verbatim', () => {
    const original = 'Your role: Engineer\n\nYou write code.';
    const result = applyChatNudge(original);
    expect(result).toContain(original);
  });
});
