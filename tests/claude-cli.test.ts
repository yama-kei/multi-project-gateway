import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseClaudeJsonOutput, buildClaudeArgs, friendlyError, runClaude } from '../src/claude-cli.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof child_process>('node:child_process');
  return { ...actual, spawn: actual.spawn };
});

describe('parseClaudeJsonOutput', () => {
  it('extracts result text and session_id from JSON output', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello! I fixed the bug.',
      session_id: 'abc-123-def',
    });
    const parsed = parseClaudeJsonOutput(json);
    expect(parsed.text).toBe('Hello! I fixed the bug.');
    expect(parsed.sessionId).toBe('abc-123-def');
    expect(parsed.isError).toBe(false);
  });

  it('handles error results', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Something went wrong',
      session_id: 'abc-123-def',
    });
    const parsed = parseClaudeJsonOutput(json);
    expect(parsed.isError).toBe(true);
    expect(parsed.text).toBe('Something went wrong');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseClaudeJsonOutput('not json')).toThrow();
  });
});

describe('buildClaudeArgs', () => {
  const baseArgs = ['--dangerously-skip-permissions', '--output-format', 'json'];

  it('builds args for a new session', () => {
    const args = buildClaudeArgs(baseArgs, 'Fix the bug', undefined);
    expect(args).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      'Fix the bug',
    ]);
  });

  it('builds args with --resume for existing session', () => {
    const args = buildClaudeArgs(baseArgs, 'Now add tests', 'session-uuid-123');
    expect(args).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--resume', 'session-uuid-123',
      'Now add tests',
    ]);
  });
});

describe('friendlyError', () => {
  it('detects rate limit errors', () => {
    expect(friendlyError('API Error: Rate limit reached')).toContain('usage limit reached');
  });

  it('detects rate_limit_error JSON type', () => {
    expect(friendlyError('429 {"type":"error","error":{"type":"rate_limit_error"}}')).toContain('usage limit reached');
  });

  it('detects overloaded errors', () => {
    expect(friendlyError('API Error (529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}})')).toContain('overloaded');
  });

  it('detects authentication errors', () => {
    expect(friendlyError('Invalid API key')).toContain('authentication failed');
  });

  it('detects authentication_error JSON type', () => {
    expect(friendlyError('{"type":"error","error":{"type":"authentication_error"}}')).toContain('authentication failed');
  });

  it('detects empty response errors', () => {
    expect(friendlyError('No messages returned')).toContain('empty response');
  });

  it('falls back to truncated raw error for unknown patterns', () => {
    const msg = friendlyError('something unexpected happened');
    expect(msg).toContain('Claude error:');
    expect(msg).toContain('something unexpected happened');
  });
});

describe('runClaude timeout', () => {
  it('rejects with a timeout error when process exceeds timeoutMs', async () => {
    const { EventEmitter } = await import('node:events');
    const { Readable } = await import('node:stream');

    const mockProc = new EventEmitter() as any;
    mockProc.stdout = new Readable({ read() {} });
    mockProc.stderr = new Readable({ read() {} });
    mockProc.kill = vi.fn(() => {
      setTimeout(() => mockProc.emit('close', null), 10);
    });

    const spawnSpy = vi.spyOn(child_process, 'spawn').mockReturnValueOnce(mockProc as any);

    const result = runClaude('/tmp', [], 'hello', undefined, { timeoutMs: 100 });
    await expect(result).rejects.toThrow(/timed out/i);

    spawnSpy.mockRestore();
  });

  it('completes normally when process finishes before timeout', async () => {
    // Spawn a quick echo command — mock spawn to return valid JSON
    const { EventEmitter } = await import('node:events');
    const { Readable } = await import('node:stream');

    const jsonOutput = JSON.stringify({
      result: 'done',
      session_id: 'sess-1',
      is_error: false,
    });

    const mockProc = new EventEmitter() as any;
    mockProc.stdout = Readable.from([Buffer.from(jsonOutput)]);
    mockProc.stderr = Readable.from([]);
    mockProc.kill = vi.fn();

    const spawnSpy = vi.spyOn(child_process, 'spawn').mockReturnValueOnce(mockProc as any);

    const promise = runClaude('/tmp', [], 'hello', undefined, { timeoutMs: 5000 });

    // Simulate process close after stdout is consumed
    setTimeout(() => mockProc.emit('close', 0), 50);

    const result = await promise;
    expect(result.text).toBe('done');
    expect(result.sessionId).toBe('sess-1');
    expect(mockProc.kill).not.toHaveBeenCalled();

    spawnSpy.mockRestore();
  });

  it('kills the subprocess when timeout fires', async () => {
    const { EventEmitter } = await import('node:events');
    const { Readable } = await import('node:stream');

    const mockProc = new EventEmitter() as any;
    // stdout that never ends
    mockProc.stdout = new Readable({ read() {} });
    mockProc.stderr = new Readable({ read() {} });
    mockProc.kill = vi.fn(() => {
      // Simulate the process exiting after being killed
      setTimeout(() => mockProc.emit('close', null), 10);
    });

    const spawnSpy = vi.spyOn(child_process, 'spawn').mockReturnValueOnce(mockProc as any);

    const promise = runClaude('/tmp', [], 'hello', undefined, { timeoutMs: 100 });
    await expect(promise).rejects.toThrow(/timed out/i);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

    spawnSpy.mockRestore();
  });

  it('uses no timeout by default (timeoutMs not provided)', async () => {
    const { EventEmitter } = await import('node:events');
    const { Readable } = await import('node:stream');

    const jsonOutput = JSON.stringify({
      result: 'ok',
      session_id: 'sess-2',
      is_error: false,
    });

    const mockProc = new EventEmitter() as any;
    mockProc.stdout = Readable.from([Buffer.from(jsonOutput)]);
    mockProc.stderr = Readable.from([]);
    mockProc.kill = vi.fn();

    const spawnSpy = vi.spyOn(child_process, 'spawn').mockReturnValueOnce(mockProc as any);

    const promise = runClaude('/tmp', [], 'hello', undefined);
    setTimeout(() => mockProc.emit('close', 0), 50);

    const result = await promise;
    expect(result.text).toBe('ok');
    expect(mockProc.kill).not.toHaveBeenCalled();

    spawnSpy.mockRestore();
  });
});
