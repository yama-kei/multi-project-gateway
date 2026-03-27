import { describe, it, expect } from 'vitest';
import { resolveServiceDir, resolveServicePath } from '../src/daemon.js';

describe('resolveServiceDir', () => {
  it('returns systemd user unit directory', () => {
    const dir = resolveServiceDir();
    expect(dir).toMatch(/\.config\/systemd\/user$/);
  });
});

describe('resolveServicePath', () => {
  it('returns path with unit file name', () => {
    const path = resolveServicePath();
    expect(path).toMatch(/mpg\.service$/);
  });

  it('includes profile in path', () => {
    const path = resolveServicePath('work');
    expect(path).toMatch(/mpg-work\.service$/);
  });
});
