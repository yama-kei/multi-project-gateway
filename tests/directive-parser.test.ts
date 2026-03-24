import { describe, it, expect } from 'vitest';
import { parseDirective } from '../src/directive-parser.js';

describe('parseDirective', () => {
  it('returns null directive when no block is present', () => {
    const result = parseDirective('Just a normal response with no directives.');
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe('Just a normal response with no directives.');
  });

  it('extracts a POST_TO directive from the end of the response', () => {
    const input = [
      'Here is my analysis.',
      '',
      '---mpg-directive',
      'POST_TO: #engineer',
      'Please implement the login flow as described above.',
      '---',
    ].join('\n');
    const result = parseDirective(input);
    expect(result.cleanText).toBe('Here is my analysis.');
    expect(result.directive).toEqual({
      action: 'POST_TO',
      targetChannel: 'engineer',
      content: 'Please implement the login flow as described above.',
    });
  });

  it('handles multi-line directive content', () => {
    const input = [
      'Done thinking.',
      '',
      '---mpg-directive',
      'POST_TO: #engineer',
      'Line one of the message.',
      'Line two of the message.',
      '',
      'Line four after a blank.',
      '---',
    ].join('\n');
    const result = parseDirective(input);
    expect(result.cleanText).toBe('Done thinking.');
    expect(result.directive).not.toBeNull();
    expect(result.directive!.content).toBe(
      'Line one of the message.\nLine two of the message.\n\nLine four after a blank.'
    );
  });

  it('strips # prefix from channel name', () => {
    const input = '---mpg-directive\nPOST_TO: #my-channel\nhello\n---';
    const result = parseDirective(input);
    expect(result.directive!.targetChannel).toBe('my-channel');
  });

  it('handles channel name without # prefix', () => {
    const input = '---mpg-directive\nPOST_TO: engineer\nhello\n---';
    const result = parseDirective(input);
    expect(result.directive!.targetChannel).toBe('engineer');
  });

  it('ignores trailing whitespace after closing delimiter', () => {
    const input = 'Response.\n\n---mpg-directive\nPOST_TO: #eng\ndo it\n---\n  \n';
    const result = parseDirective(input);
    expect(result.directive).not.toBeNull();
    expect(result.directive!.targetChannel).toBe('eng');
  });

  it('returns null directive for malformed block (missing action line)', () => {
    const input = 'Response.\n\n---mpg-directive\n\n---';
    const result = parseDirective(input);
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe(input);
  });

  it('returns null directive for unknown action type', () => {
    const input = 'Response.\n\n---mpg-directive\nSEND_FILE: #eng\nfoo\n---';
    const result = parseDirective(input);
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe(input);
  });

  it('returns null directive for block not at the end', () => {
    const input = [
      '---mpg-directive',
      'POST_TO: #engineer',
      'hello',
      '---',
      '',
      'More text after the block.',
    ].join('\n');
    const result = parseDirective(input);
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe(input);
  });

  it('returns null directive for missing closing delimiter', () => {
    const input = 'Response.\n\n---mpg-directive\nPOST_TO: #eng\ndo it';
    const result = parseDirective(input);
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe(input);
  });

  it('returns empty cleanText when entire response is a directive', () => {
    const input = '---mpg-directive\nPOST_TO: #eng\nhello world\n---';
    const result = parseDirective(input);
    expect(result.cleanText).toBe('');
    expect(result.directive).not.toBeNull();
  });
});
