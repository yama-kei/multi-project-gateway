import { resolvePreset } from './persona-presets.js';
import { isValidLogLevel, type LogLevel } from './logger.js';

export interface AgentConfig {
  role: string;
  prompt: string;
}

export interface AgentInputConfig {
  preset?: string;
  role?: string;
  prompt?: string;
}

export interface ProjectConfig {
  name: string;
  directory: string;
  idleTimeoutMs?: number;
  claudeArgs?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  agents?: Record<string, AgentConfig>;
  allowedRoles?: string[];
  rateLimitPerUser?: number;
}

export const DEFAULT_ALLOWED_TOOLS: string[] = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git:*)',
  'TodoWrite',
];

export type RuntimePersistence = 'direct' | 'tmux';

export interface GatewayDefaults {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  sessionTtlMs: number;
  maxPersistedSessions: number;
  claudeArgs: string[];
  allowedTools: string[];
  disallowedTools: string[];
  maxTurnsPerAgent: number;
  agentTimeoutMs: number;
  httpPort: number | false;
  logLevel: LogLevel;
  persistence: RuntimePersistence;
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
    let agents: Record<string, AgentConfig> | undefined;
    if (Array.isArray(p.agents)) {
      // Shorthand: ["pm", "engineer"] — resolve each as a preset
      agents = {};
      for (const entry of p.agents) {
        if (typeof entry === 'string') {
          const name = entry.toLowerCase();
          const preset = resolvePreset(name);
          if (preset) {
            agents[name] = { ...preset };
          }
        }
      }
      if (Object.keys(agents).length === 0) agents = undefined;
    } else if (p.agents && typeof p.agents === 'object') {
      agents = {};
      for (const [agentName, agentCfg] of Object.entries(p.agents as Record<string, unknown>)) {
        const ac = agentCfg as Record<string, unknown>;
        const name = agentName.toLowerCase();

        if (typeof ac.preset === 'string') {
          // Preset-based: resolve preset, then merge overrides
          const preset = resolvePreset(ac.preset);
          if (preset) {
            const role = typeof ac.role === 'string' ? ac.role : preset.role;
            const basePrompt = preset.prompt;
            const extra = typeof ac.prompt === 'string' ? ac.prompt : '';
            const prompt = extra ? `${basePrompt}\n\n${extra}` : basePrompt;
            agents[name] = { role, prompt };
          }
        } else if (typeof ac.role === 'string' && typeof ac.prompt === 'string') {
          // Inline: original behavior
          agents[name] = { role: ac.role, prompt: ac.prompt };
        }
      }
      if (Object.keys(agents).length === 0) agents = undefined;
    }

    const projectAllowed = Array.isArray(p.allowedTools) ? (p.allowedTools as string[]) : undefined;
    const projectDisallowed = Array.isArray(p.disallowedTools) ? (p.disallowedTools as string[]) : undefined;
    if (projectAllowed && projectDisallowed) {
      console.warn(`Warning: project "${typeof p.name === 'string' ? p.name : channelId}" sets both allowedTools and disallowedTools — they conflict. allowedTools takes precedence.`);
    }

    const allowedRoles = Array.isArray(p.allowedRoles) ? (p.allowedRoles as string[]).filter(r => typeof r === 'string') : undefined;
    const rateLimitPerUser = typeof p.rateLimitPerUser === 'number' && p.rateLimitPerUser > 0 ? p.rateLimitPerUser : undefined;

    validated[channelId] = {
      name: typeof p.name === 'string' ? p.name : channelId,
      directory: p.directory,
      ...(p.idleTimeoutMs !== undefined && { idleTimeoutMs: Number(p.idleTimeoutMs) }),
      ...(Array.isArray(p.claudeArgs) && { claudeArgs: p.claudeArgs as string[] }),
      ...(projectAllowed && { allowedTools: projectAllowed }),
      ...(projectDisallowed && { disallowedTools: projectDisallowed }),
      ...(agents && { agents }),
      ...(allowedRoles && allowedRoles.length > 0 && { allowedRoles }),
      ...(rateLimitPerUser !== undefined && { rateLimitPerUser }),
    };
  }

  const defaults = (obj.defaults ?? {}) as Record<string, unknown>;

  const defaultAllowed = Array.isArray(defaults.allowedTools) ? (defaults.allowedTools as string[]) : DEFAULT_ALLOWED_TOOLS;
  const defaultDisallowed = Array.isArray(defaults.disallowedTools) ? (defaults.disallowedTools as string[]) : [];
  if (Array.isArray(defaults.allowedTools) && Array.isArray(defaults.disallowedTools)) {
    console.warn('Warning: gateway defaults set both allowedTools and disallowedTools — they conflict. allowedTools takes precedence.');
  }

  return {
    defaults: {
      idleTimeoutMs: typeof defaults.idleTimeoutMs === 'number' ? defaults.idleTimeoutMs : 1800000,
      maxConcurrentSessions: typeof defaults.maxConcurrentSessions === 'number' ? defaults.maxConcurrentSessions : 4,
      sessionTtlMs: typeof defaults.sessionTtlMs === 'number' ? defaults.sessionTtlMs : 7 * 24 * 60 * 60 * 1000,
      maxPersistedSessions: typeof defaults.maxPersistedSessions === 'number' ? defaults.maxPersistedSessions : 50,
      claudeArgs: Array.isArray(defaults.claudeArgs) ? (defaults.claudeArgs as string[]) : ['--permission-mode', 'acceptEdits', '--output-format', 'json'],
      allowedTools: defaultAllowed,
      disallowedTools: defaultDisallowed,
      maxTurnsPerAgent: typeof defaults.maxTurnsPerAgent === 'number' ? defaults.maxTurnsPerAgent : 5,
      agentTimeoutMs: typeof defaults.agentTimeoutMs === 'number' ? defaults.agentTimeoutMs : 3 * 60 * 1000,
      httpPort: defaults.httpPort === false ? false : (typeof defaults.httpPort === 'number' ? defaults.httpPort : 3100),
      logLevel: isValidLogLevel(defaults.logLevel) ? defaults.logLevel : 'info',
      persistence: defaults.persistence === 'tmux' ? 'tmux' : 'direct',
    },
    projects: validated,
  };
}
