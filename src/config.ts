export interface PersonaConfig {
  systemPrompt: string;
  canMessageChannels: string[];
  maxDirectivesPerTurn: number;
}

export interface ProjectConfig {
  name: string;
  directory: string;
  idleTimeoutMs?: number;
  claudeArgs?: string[];
  persona?: PersonaConfig;
}

export interface GatewayDefaults {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  sessionTtlMs: number;
  maxPersistedSessions: number;
  claudeArgs: string[];
  maxTurnsPerLink: number;
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
    let persona: PersonaConfig | undefined;
    if (p.persona && typeof p.persona === 'object') {
      const per = p.persona as Record<string, unknown>;
      if (typeof per.systemPrompt === 'string' && Array.isArray(per.canMessageChannels)) {
        persona = {
          systemPrompt: per.systemPrompt,
          canMessageChannels: per.canMessageChannels as string[],
          maxDirectivesPerTurn: typeof per.maxDirectivesPerTurn === 'number' ? per.maxDirectivesPerTurn : 1,
        };
      }
    }

    validated[channelId] = {
      name: typeof p.name === 'string' ? p.name : channelId,
      directory: p.directory,
      ...(p.idleTimeoutMs !== undefined && { idleTimeoutMs: Number(p.idleTimeoutMs) }),
      ...(Array.isArray(p.claudeArgs) && { claudeArgs: p.claudeArgs as string[] }),
      ...(persona && { persona }),
    };
  }

  const defaults = (obj.defaults ?? {}) as Record<string, unknown>;

  return {
    defaults: {
      idleTimeoutMs: typeof defaults.idleTimeoutMs === 'number' ? defaults.idleTimeoutMs : 1800000,
      maxConcurrentSessions: typeof defaults.maxConcurrentSessions === 'number' ? defaults.maxConcurrentSessions : 4,
      sessionTtlMs: typeof defaults.sessionTtlMs === 'number' ? defaults.sessionTtlMs : 7 * 24 * 60 * 60 * 1000,
      maxPersistedSessions: typeof defaults.maxPersistedSessions === 'number' ? defaults.maxPersistedSessions : 50,
      claudeArgs: Array.isArray(defaults.claudeArgs) ? (defaults.claudeArgs as string[]) : ['--permission-mode', 'acceptEdits', '--output-format', 'json'],
      maxTurnsPerLink: typeof defaults.maxTurnsPerLink === 'number' ? defaults.maxTurnsPerLink : 5,
    },
    projects: validated,
  };
}

export function findChannelByName(
  config: GatewayConfig,
  name: string,
): { channelId: string; name: string; directory: string } | null {
  const lower = name.toLowerCase();
  for (const [channelId, project] of Object.entries(config.projects)) {
    if (project.name.toLowerCase() === lower) {
      return { channelId, name: project.name, directory: project.directory };
    }
  }
  return null;
}
