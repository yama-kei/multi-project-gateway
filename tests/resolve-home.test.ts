import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  resolveMpgHome,
  resolveProfileDir,
  resolveEnvPath,
  resolveConfigPath,
  resolveSessionsPath,
  parseFlags,
} from '../src/resolve-home.js';

describe('resolveMpgHome', () => {
  const originalEnv = process.env.MPG_HOME;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MPG_HOME;
    } else {
      process.env.MPG_HOME = originalEnv;
    }
  });

  it('returns MPG_HOME env var when set', () => {
    process.env.MPG_HOME = '/custom/mpg/home';
    expect(resolveMpgHome()).toBe('/custom/mpg/home');
  });

  it('returns ~/.mpg when MPG_HOME is not set', () => {
    delete process.env.MPG_HOME;
    expect(resolveMpgHome()).toBe(resolve(homedir(), '.mpg'));
  });
});

describe('resolveProfileDir', () => {
  const originalEnv = process.env.MPG_HOME;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MPG_HOME;
    } else {
      process.env.MPG_HOME = originalEnv;
    }
  });

  it('returns profiles/<name> under MPG_HOME', () => {
    process.env.MPG_HOME = '/custom/mpg';
    expect(resolveProfileDir('dev')).toBe('/custom/mpg/profiles/dev');
  });

  it('returns profiles/default under ~/.mpg when no MPG_HOME', () => {
    delete process.env.MPG_HOME;
    expect(resolveProfileDir('default')).toBe(
      resolve(homedir(), '.mpg', 'profiles', 'default'),
    );
  });
});

describe('resolveEnvPath', () => {
  let tempDir: string;
  const originalEnv = process.env.MPG_HOME;
  const originalCwd = process.cwd;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resolve-env-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.MPG_HOME;
    } else {
      process.env.MPG_HOME = originalEnv;
    }
    process.cwd = originalCwd;
  });

  it('returns MPG_HOME/.env when it exists', () => {
    process.env.MPG_HOME = tempDir;
    writeFileSync(join(tempDir, '.env'), 'TOKEN=abc');

    const result = resolveEnvPath();
    expect(result).toBe(join(tempDir, '.env'));
  });

  it('falls back to CWD/.env when MPG_HOME/.env does not exist', () => {
    const cwdDir = mkdtempSync(join(tmpdir(), 'resolve-env-cwd-'));
    process.env.MPG_HOME = tempDir; // no .env here
    writeFileSync(join(cwdDir, '.env'), 'TOKEN=xyz');
    process.cwd = () => cwdDir;

    const result = resolveEnvPath();
    expect(result).toBe(join(cwdDir, '.env'));

    rmSync(cwdDir, { recursive: true, force: true });
  });

  it('returns undefined when no .env found anywhere', () => {
    process.env.MPG_HOME = tempDir;
    const cwdDir = mkdtempSync(join(tmpdir(), 'resolve-env-empty-'));
    process.cwd = () => cwdDir;

    const result = resolveEnvPath();
    expect(result).toBeUndefined();

    rmSync(cwdDir, { recursive: true, force: true });
  });

  it('prefers MPG_HOME/.env over CWD/.env', () => {
    const cwdDir = mkdtempSync(join(tmpdir(), 'resolve-env-both-'));
    process.env.MPG_HOME = tempDir;
    writeFileSync(join(tempDir, '.env'), 'TOKEN=mpg');
    writeFileSync(join(cwdDir, '.env'), 'TOKEN=cwd');
    process.cwd = () => cwdDir;

    const result = resolveEnvPath();
    expect(result).toBe(join(tempDir, '.env'));

    rmSync(cwdDir, { recursive: true, force: true });
  });
});

describe('resolveConfigPath', () => {
  let tempDir: string;
  const originalEnv = process.env.MPG_HOME;
  const originalCwd = process.cwd;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resolve-config-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.MPG_HOME;
    } else {
      process.env.MPG_HOME = originalEnv;
    }
    process.cwd = originalCwd;
  });

  it('returns --config flag path when provided (even if file missing)', () => {
    const explicitPath = join(tempDir, 'custom-config.json');
    const result = resolveConfigPath({ configFlag: explicitPath });
    expect(result).toBe(explicitPath);
  });

  it('returns --config flag path when file exists', () => {
    const explicitPath = join(tempDir, 'custom-config.json');
    writeFileSync(explicitPath, '{}');
    const result = resolveConfigPath({ configFlag: explicitPath });
    expect(result).toBe(explicitPath);
  });

  it('returns --profile path when provided', () => {
    process.env.MPG_HOME = tempDir;
    const profileDir = join(tempDir, 'profiles', 'dev');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'config.json'), '{}');

    const result = resolveConfigPath({ profileFlag: 'dev' });
    expect(result).toBe(join(profileDir, 'config.json'));
  });

  it('returns default profile config when it exists', () => {
    process.env.MPG_HOME = tempDir;
    const defaultDir = join(tempDir, 'profiles', 'default');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, 'config.json'), '{}');

    const result = resolveConfigPath();
    expect(result).toBe(join(defaultDir, 'config.json'));
  });

  it('falls back to CWD/config.json', () => {
    process.env.MPG_HOME = tempDir; // no profiles here
    const cwdDir = mkdtempSync(join(tmpdir(), 'resolve-config-cwd-'));
    writeFileSync(join(cwdDir, 'config.json'), '{}');
    process.cwd = () => cwdDir;

    const result = resolveConfigPath();
    expect(result).toBe(join(cwdDir, 'config.json'));

    rmSync(cwdDir, { recursive: true, force: true });
  });

  it('returns undefined when nothing found', () => {
    process.env.MPG_HOME = tempDir;
    const cwdDir = mkdtempSync(join(tmpdir(), 'resolve-config-empty-'));
    process.cwd = () => cwdDir;

    const result = resolveConfigPath();
    expect(result).toBeUndefined();

    rmSync(cwdDir, { recursive: true, force: true });
  });

  it('--config takes priority over --profile', () => {
    process.env.MPG_HOME = tempDir;
    const explicitPath = join(tempDir, 'explicit.json');
    writeFileSync(explicitPath, '{}');

    const profileDir = join(tempDir, 'profiles', 'dev');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'config.json'), '{}');

    const result = resolveConfigPath({ configFlag: explicitPath, profileFlag: 'dev' });
    expect(result).toBe(explicitPath);
  });

  it('--profile takes priority over default profile', () => {
    process.env.MPG_HOME = tempDir;

    const defaultDir = join(tempDir, 'profiles', 'default');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, 'config.json'), '{"source":"default"}');

    const devDir = join(tempDir, 'profiles', 'dev');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(devDir, 'config.json'), '{"source":"dev"}');

    const result = resolveConfigPath({ profileFlag: 'dev' });
    expect(result).toBe(join(devDir, 'config.json'));
  });
});

describe('resolveSessionsPath', () => {
  it('returns sessions.json in same directory as config', () => {
    expect(resolveSessionsPath('/home/user/.mpg/profiles/default/config.json')).toBe(
      '/home/user/.mpg/profiles/default/sessions.json',
    );
  });

  it('works with CWD config path', () => {
    expect(resolveSessionsPath('/some/project/config.json')).toBe(
      '/some/project/sessions.json',
    );
  });
});

describe('parseFlags', () => {
  it('parses --config flag', () => {
    const result = parseFlags(['start', '--config', '/path/to/config.json']);
    expect(result.configFlag).toBe('/path/to/config.json');
  });

  it('parses --profile flag', () => {
    const result = parseFlags(['start', '--profile', 'dev']);
    expect(result.profileFlag).toBe('dev');
  });

  it('parses --migrate flag', () => {
    const result = parseFlags(['init', '--migrate']);
    expect(result.migrate).toBe(true);
  });

  it('parses all flags together', () => {
    const result = parseFlags(['--profile', 'dev', '--config', '/p.json', '--migrate']);
    expect(result.profileFlag).toBe('dev');
    expect(result.configFlag).toBe('/p.json');
    expect(result.migrate).toBe(true);
  });

  it('returns empty object for no flags', () => {
    const result = parseFlags(['start']);
    expect(result.configFlag).toBeUndefined();
    expect(result.profileFlag).toBeUndefined();
    expect(result.migrate).toBeUndefined();
  });
});
