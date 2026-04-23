import { describe, it, expect } from 'vitest';
import { resolveLifeContextRun } from '../src/life-context-spawn.js';

describe('resolveLifeContextRun', () => {
  it('appends life-context extras to gateway tool args so --allowed-tools survives for life-* agents', () => {
    const getRunArgs = (name: string) =>
      name === 'life-work'
        ? { cwd: '/vault/topics/work', extraArgs: ['--add-dir', '/vault/_identity'] }
        : null;

    const result = resolveLifeContextRun(
      getRunArgs,
      'life-work',
      '/project',
      ['--allowed-tools', 'Read', 'Edit', 'Bash(gh:*)', 'Bash(git:*)'],
    );

    expect(result.cwd).toBe('/vault/topics/work');
    expect(result.extraArgs).toEqual([
      '--allowed-tools', 'Read', 'Edit', 'Bash(gh:*)', 'Bash(git:*)',
      '--add-dir', '/vault/_identity',
    ]);
  });

  it('falls back to project cwd and default extras for non-life agents', () => {
    const getRunArgs = () => null;

    const result = resolveLifeContextRun(
      getRunArgs,
      'pm',
      '/project',
      ['--allowed-tools', 'Read'],
    );

    expect(result.cwd).toBe('/project');
    expect(result.extraArgs).toEqual(['--allowed-tools', 'Read']);
  });

  it('returns undefined extraArgs when defaults are empty and no life-context runs', () => {
    const getRunArgs = () => null;

    const result = resolveLifeContextRun(getRunArgs, undefined, '/project', []);

    expect(result.cwd).toBe('/project');
    expect(result.extraArgs).toBeUndefined();
  });
});
