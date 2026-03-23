export interface ProjectConfig {
  name: string;
  directory: string;
  idleTimeoutMinutes?: number;
  claudeArgs?: string[];
}

export interface GatewayDefaults {
  idleTimeoutMinutes: number;
  maxConcurrentSessions: number;
  claudeArgs: string[];
}

export interface GatewayConfig {
  defaults: GatewayDefaults;
  projects: Record<string, ProjectConfig>;
}

export function loadConfig(raw: unknown): GatewayConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be an object');
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.projects || typeof obj.projects !== 'object') {
    throw new Error('Config must have a "projects" object');
  }

  const projects = obj.projects as Record<string, unknown>;
  const validated: Record<string, ProjectConfig> = {};

  for (const [channelId, project] of Object.entries(projects)) {
    if (!project || typeof project !== 'object') {
      throw new Error(`Project for channel ${channelId} must be an object`);
    }
    const p = project as Record<string, unknown>;
    if (typeof p.directory !== 'string' || !p.directory) {
      throw new Error(`Project for channel ${channelId} must have a "directory" string`);
    }
    validated[channelId] = {
      name: typeof p.name === 'string' ? p.name : channelId,
      directory: p.directory,
      ...(p.idleTimeoutMinutes !== undefined && { idleTimeoutMinutes: Number(p.idleTimeoutMinutes) }),
      ...(Array.isArray(p.claudeArgs) && { claudeArgs: p.claudeArgs as string[] }),
    };
  }

  const defaults = (obj.defaults ?? {}) as Record<string, unknown>;

  return {
    defaults: {
      idleTimeoutMinutes: typeof defaults.idleTimeoutMinutes === 'number' ? defaults.idleTimeoutMinutes : 1440,
      maxConcurrentSessions: typeof defaults.maxConcurrentSessions === 'number' ? defaults.maxConcurrentSessions : 4,
      claudeArgs: Array.isArray(defaults.claudeArgs) ? (defaults.claudeArgs as string[]) : ['--permission-mode', 'acceptEdits', '--output-format', 'json'],
    },
    projects: validated,
  };
}
