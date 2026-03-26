import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Returns the MPG home directory.
 * Priority: MPG_HOME env var > ~/.mpg
 */
export function resolveMpgHome(): string {
  return process.env.MPG_HOME ?? resolve(homedir(), '.mpg');
}

/**
 * Returns the profile directory for a given profile name.
 */
export function resolveProfileDir(profile: string): string {
  return resolve(resolveMpgHome(), 'profiles', profile);
}

export interface ResolvedPaths {
  envPath: string | undefined;
  configPath: string;
  sessionsPath: string;
}

/**
 * Resolve .env path using the resolution order:
 * 1. Environment variables (already set) — highest priority (returns undefined, already loaded)
 * 2. $MPG_HOME/.env
 * 3. $CWD/.env — backward compat
 */
export function resolveEnvPath(): string | undefined {
  const mpgHome = resolveMpgHome();
  const mpgEnv = resolve(mpgHome, '.env');
  if (existsSync(mpgEnv)) {
    return mpgEnv;
  }

  const cwdEnv = resolve(process.cwd(), '.env');
  if (existsSync(cwdEnv)) {
    return cwdEnv;
  }

  return undefined;
}

/**
 * Resolve config.json path using the resolution order:
 * 1. --config <path> CLI flag (explicit path)
 * 2. --profile <name> → $MPG_HOME/profiles/<name>/config.json
 * 3. $MPG_HOME/profiles/default/config.json
 * 4. $CWD/config.json — backward compat fallback
 *
 * Returns the resolved config path, or undefined if none found.
 */
export function resolveConfigPath(options?: {
  configFlag?: string;
  profileFlag?: string;
}): string | undefined {
  // 1. Explicit --config flag
  if (options?.configFlag) {
    const explicit = resolve(options.configFlag);
    if (existsSync(explicit)) {
      return explicit;
    }
    return explicit; // Return even if missing — let caller handle error
  }

  // 2. --profile flag
  if (options?.profileFlag) {
    const profileConfig = resolve(
      resolveProfileDir(options.profileFlag),
      'config.json',
    );
    if (existsSync(profileConfig)) {
      return profileConfig;
    }
    return profileConfig; // Return even if missing — let caller handle error
  }

  // 3. MPG_HOME/profiles/default/config.json
  const mpgHome = resolveMpgHome();
  const defaultConfig = resolve(mpgHome, 'profiles', 'default', 'config.json');
  if (existsSync(defaultConfig)) {
    return defaultConfig;
  }

  // 4. CWD/config.json — backward compat
  const cwdConfig = resolve(process.cwd(), 'config.json');
  if (existsSync(cwdConfig)) {
    return cwdConfig;
  }

  return undefined;
}

/**
 * Resolve sessions.json path — always co-located with the resolved config.json.
 */
export function resolveSessionsPath(configPath: string): string {
  return resolve(dirname(configPath), 'sessions.json');
}

/**
 * Parse --config, --profile flags from argv.
 */
export function parseFlags(argv: string[]): {
  configFlag?: string;
  profileFlag?: string;
  migrate?: boolean;
  project?: string;
  level?: string;
} {
  const result: { configFlag?: string; profileFlag?: string; migrate?: boolean; project?: string; level?: string } = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && i + 1 < argv.length) {
      result.configFlag = argv[i + 1];
      i++;
    } else if (argv[i] === '--profile' && i + 1 < argv.length) {
      result.profileFlag = argv[i + 1];
      i++;
    } else if (argv[i] === '--project' && i + 1 < argv.length) {
      result.project = argv[i + 1];
      i++;
    } else if (argv[i] === '--level' && i + 1 < argv.length) {
      result.level = argv[i + 1];
      i++;
    } else if (argv[i] === '--migrate') {
      result.migrate = true;
    }
  }

  return result;
}
