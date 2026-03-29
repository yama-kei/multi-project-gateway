import { describe, it, expect, vi } from 'vitest';
import { parseClaudeJsonOutput, buildClaudeArgs, buildToolArgs, friendlyError, runClaude } from '../src/claude-cli.js';

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

describe('parseClaudeJsonOutput — usage extraction', () => {
  it('extracts ClaudeUsage when usage fields are present', () => {
    const raw = JSON.stringify({
      result: 'Hello',
      session_id: 'sess-1',
      is_error: false,
      total_cost_usd: 0.042,
      duration_ms: 45000,
      duration_api_ms: 38000,
      num_turns: 12,
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 15000,
        output_tokens: 3200,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 8000,
      },
    });
    const result = parseClaudeJsonOutput(raw);
    expect(result.usage).toBeDefined();
    expect(result.usage!.input_tokens).toBe(15000);
    expect(result.usage!.output_tokens).toBe(3200);
    expect(result.usage!.cache_creation_input_tokens).toBe(5000);
    expect(result.usage!.cache_read_input_tokens).toBe(8000);
    expect(result.usage!.total_cost_usd).toBe(0.042);
    expect(result.usage!.duration_ms).toBe(45000);
    expect(result.usage!.duration_api_ms).toBe(38000);
    expect(result.usage!.num_turns).toBe(12);
    expect(result.usage!.model).toBe('claude-sonnet-4-20250514');
  });

  it('returns undefined usage when no usage fields present', () => {
    const raw = JSON.stringify({
      result: 'Hello',
      session_id: 'sess-1',
      is_error: false,
    });
    const result = parseClaudeJsonOutput(raw);
    expect(result.usage).toBeUndefined();
  });

  it('handles partial usage — total_cost_usd without nested usage object', () => {
    const raw = JSON.stringify({
      result: 'Hello',
      session_id: 'sess-1',
      is_error: false,
      total_cost_usd: 0.01,
    });
    const result = parseClaudeJsonOutput(raw);
    expect(result.usage).toBeDefined();
    expect(result.usage!.total_cost_usd).toBe(0.01);
    expect(result.usage!.input_tokens).toBe(0);
    expect(result.usage!.output_tokens).toBe(0);
  });

  it('extracts model from first key of modelUsage when model field is absent', () => {
    const raw = JSON.stringify({
      result: 'Hello',
      session_id: 'sess-1',
      is_error: false,
      total_cost_usd: 0.05,
      modelUsage: { 'claude-opus-4-6': { input_tokens: 1000 } },
    });
    const result = parseClaudeJsonOutput(raw);
    expect(result.usage!.model).toBe('claude-opus-4-6');
  });
});

describe('buildClaudeArgs', () => {
  const baseArgs = ['--dangerously-skip-permissions', '--output-format', 'json'];

  it('builds args with prompt before baseArgs (avoids variadic flag consumption)', () => {
    const args = buildClaudeArgs(baseArgs, 'Fix the bug', undefined);
    expect(args).toEqual([
      '--print',
      'Fix the bug',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ]);
  });

  it('builds args with --resume for existing session', () => {
    const args = buildClaudeArgs(baseArgs, 'Now add tests', 'session-uuid-123');
    expect(args).toEqual([
      '--print',
      'Now add tests',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--resume', 'session-uuid-123',
    ]);
  });

  it('prompt is not consumed by --allowed-tools', () => {
    const argsWithTools = ['--allowed-tools', 'Read', 'Edit', 'Bash(git:*)'];
    const args = buildClaudeArgs(argsWithTools, 'Do something', undefined);
    expect(args.indexOf('Do something')).toBe(1); // right after --print, before --allowed-tools
  });

  it('includes --append-system-prompt when provided', () => {
    const args = buildClaudeArgs([], 'hello', undefined, 'You are a PM.');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('You are a PM.');
  });

  it('omits --append-system-prompt when not provided', () => {
    const args = buildClaudeArgs([], 'hello', undefined);
    expect(args).not.toContain('--append-system-prompt');
  });
});

describe('buildToolArgs', () => {
  it('returns --allowed-tools from defaults when no project overrides', () => {
    const args = buildToolArgs(
      { allowedTools: ['Read', 'Edit', 'Grep'] },
    );
    expect(args).toEqual(['--allowed-tools', 'Read', 'Edit', 'Grep']);
  });

  it('returns --disallowed-tools when only disallowedTools is set', () => {
    const args = buildToolArgs(
      { disallowedTools: ['Bash', 'WebSearch'] },
    );
    expect(args).toEqual(['--disallowed-tools', 'Bash', 'WebSearch']);
  });

  it('allowed takes precedence over disallowed (they conflict)', () => {
    const args = buildToolArgs(
      { allowedTools: ['Read'], disallowedTools: ['Bash'] },
    );
    expect(args).toEqual(['--allowed-tools', 'Read']);
    expect(args).not.toContain('--disallowed-tools');
  });

  it('project overrides take precedence over defaults', () => {
    const args = buildToolArgs(
      { allowedTools: ['Read', 'Edit'] },
      { allowedTools: ['Read', 'Edit', 'Bash'] },
    );
    expect(args).toEqual(['--allowed-tools', 'Read', 'Edit', 'Bash']);
  });

  it('project disallowedTools overrides default allowedTools', () => {
    const args = buildToolArgs(
      { allowedTools: ['Read', 'Edit'] },
      { disallowedTools: ['Bash'] },
    );
    // Project override has no allowedTools, falls back to defaults.allowedTools
    // But project sets disallowedTools — since project overrides are checked first
    // and allowedTools is undefined for project, we fall back to defaults.allowedTools
    expect(args).toEqual(['--allowed-tools', 'Read', 'Edit']);
  });

  it('returns empty array when no tools configured', () => {
    const args = buildToolArgs({});
    expect(args).toEqual([]);
  });

  it('returns empty array when allowedTools is empty', () => {
    const args = buildToolArgs({ allowedTools: [] });
    expect(args).toEqual([]);
  });

  it('skips tool args when existingArgs already has --allowed-tools', () => {
    const args = buildToolArgs(
      { allowedTools: ['Read'] },
      undefined,
      ['--output-format', 'json', '--allowed-tools', 'Bash'],
    );
    expect(args).toEqual([]);
  });

  it('skips tool args when existingArgs already has --disallowed-tools', () => {
    const args = buildToolArgs(
      { allowedTools: ['Read'] },
      undefined,
      ['--disallowed-tools', 'Bash'],
    );
    expect(args).toEqual([]);
  });

  it('skips tool args when per-project claudeArgs contain --allowed-tools (merged into existingArgs)', () => {
    // Simulates the caller merging gateway + project claudeArgs before passing to buildToolArgs
    const gatewayArgs = ['--output-format', 'json'];
    const projectArgs = ['--allowed-tools', 'Read', 'Bash'];
    const merged = [...gatewayArgs, ...projectArgs];
    const args = buildToolArgs(
      { allowedTools: ['Read', 'Edit', 'Grep'] },
      undefined,
      merged,
    );
    expect(args).toEqual([]);
  });

  it('handles undefined project overrides gracefully', () => {
    const args = buildToolArgs(
      { allowedTools: ['Read', 'Glob'] },
      undefined,
    );
    expect(args).toEqual(['--allowed-tools', 'Read', 'Glob']);
  });

  it('project with empty allowedTools falls through to disallowed', () => {
    const args = buildToolArgs(
      { disallowedTools: ['Bash'] },
      { allowedTools: [] },
    );
    // Project overrides allowedTools with empty array, so allowed is []
    // Falls to disallowed from defaults
    expect(args).toEqual(['--disallowed-tools', 'Bash']);
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
  it('rejects with timeout error when CLI process hangs', async () => {
    // Use 'sleep' as a stand-in for a hanging claude process
    const result = runClaude('/tmp', [], 'test', undefined, undefined, 200);
    await expect(result).rejects.toThrow(/timed out/i);
  }, 5_000);
});

