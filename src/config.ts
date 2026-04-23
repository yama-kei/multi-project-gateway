import { resolvePreset } from './persona-presets.js';
import { isValidLogLevel, type LogLevel } from './logger.js';

export interface AgentConfig {
  role: string;
  prompt: string;
  timeoutMs?: number;
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
  extraAllowedTools?: string[];
  agents?: Record<string, AgentConfig>;
  allowedRoles?: string[];
  rateLimitPerUser?: number;
  maxAttachmentSizeMb?: number;
  allowedMimeTypes?: string[];
  maxAttachmentsPerMessage?: number;
}

export const DEFAULT_ALLOWED_TOOLS: string[] = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git:*)',
  'Bash(gh:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(pnpm:*)',
  'Bash(yarn:*)',
  'Bash(bun:*)',
  'Bash(make:*)',
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
  extraAllowedTools?: string[];
  maxTurnsPerAgent: number;
  agentTimeoutMs: number;
  stuckNotifyMs: number;
  httpPort: number | false;
  logLevel: LogLevel;
  maxAttachmentSizeMb: number;
  allowedMimeTypes: string[];
  maxAttachmentsPerMessage: number;
  persistence: RuntimePersistence;
}

export interface GatewayConfig {
  defaults: GatewayDefaults;
  projects: Record<string, ProjectConfig>;
}

function parseExtraAllowedTools(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.warn(`Warning: ${label}.extraAllowedTools must be an array of strings — ignoring.`);
    return undefined;
  }
  const strings = (raw as unknown[]).filter((e): e is string => typeof e === 'string');
  return strings.length > 0 ? strings : undefined;
}

function mergeToolLists(base: string[], extra: string[] | undefined): string[] {
  if (!extra || extra.length === 0) return base;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of [...base, ...extra]) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    result.push(tool);
  }
  return result;
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

  const defaults = (obj.defaults ?? {}) as Record<string, unknown>;

  const defaultExtra = parseExtraAllowedTools(defaults.extraAllowedTools, 'defaults');
  const baseDefaultAllowed = Array.isArray(defaults.allowedTools)
    ? (defaults.allowedTools as string[])
    : DEFAULT_ALLOWED_TOOLS;
  const effectiveDefaultAllowed = mergeToolLists(baseDefaultAllowed, defaultExtra);

  let defaultDisallowed = Array.isArray(defaults.disallowedTools) ? (defaults.disallowedTools as string[]) : [];
  if (Array.isArray(defaults.allowedTools) && Array.isArray(defaults.disallowedTools)) {
    console.warn('Warning: gateway defaults set both allowedTools and disallowedTools — they conflict. allowedTools takes precedence.');
  }
  if (defaultExtra && defaultDisallowed.length > 0 && !Array.isArray(defaults.allowedTools)) {
    console.warn('Warning: gateway defaults set both extraAllowedTools and disallowedTools — extraAllowedTools forces allow-list mode; disallowedTools will be ignored.');
    defaultDisallowed = [];
  }

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

        const agentTimeoutMs = typeof ac.timeoutMs === 'number' && ac.timeoutMs > 0 ? ac.timeoutMs : undefined;

        if (typeof ac.preset === 'string') {
          // Preset-based: resolve preset, then merge overrides
          const preset = resolvePreset(ac.preset);
          if (preset) {
            const role = typeof ac.role === 'string' ? ac.role : preset.role;
            const basePrompt = preset.prompt;
            const extra = typeof ac.prompt === 'string' ? ac.prompt : '';
            const prompt = extra ? `${basePrompt}\n\n${extra}` : basePrompt;
            agents[name] = { role, prompt, ...(agentTimeoutMs !== undefined && { timeoutMs: agentTimeoutMs }) };
          }
        } else if (typeof ac.role === 'string' && typeof ac.prompt === 'string') {
          // Inline: original behavior
          agents[name] = { role: ac.role, prompt: ac.prompt, ...(agentTimeoutMs !== undefined && { timeoutMs: agentTimeoutMs }) };
        }
      }
      if (Object.keys(agents).length === 0) agents = undefined;
    }

    const projectAllowedRaw = Array.isArray(p.allowedTools) ? (p.allowedTools as string[]) : undefined;
    let projectDisallowed = Array.isArray(p.disallowedTools) ? (p.disallowedTools as string[]) : undefined;
    const projectName = typeof p.name === 'string' ? p.name : channelId;
    const projectExtra = parseExtraAllowedTools(p.extraAllowedTools, `project "${projectName}"`);

    if (projectAllowedRaw && projectDisallowed) {
      console.warn(`Warning: project "${projectName}" sets both allowedTools and disallowedTools — they conflict. allowedTools takes precedence.`);
    }

    // Resolve effective project allowlist:
    //  - if project.allowedTools is set → layer projectExtra on top of it
    //  - else if project.extraAllowedTools is set → layer on top of effective defaults
    //  - else → no project allowedTools (falls through to defaults at runtime)
    let projectAllowedEffective: string[] | undefined;
    if (projectAllowedRaw) {
      projectAllowedEffective = mergeToolLists(projectAllowedRaw, projectExtra);
    } else if (projectExtra) {
      projectAllowedEffective = mergeToolLists(effectiveDefaultAllowed, projectExtra);
    }

    // Project-level extraAllowedTools + disallowedTools → force allow-list mode
    if (projectExtra && projectDisallowed && !projectAllowedRaw) {
      console.warn(`Warning: project "${projectName}" sets both extraAllowedTools and disallowedTools — extraAllowedTools forces allow-list mode; disallowedTools will be ignored.`);
      projectDisallowed = undefined;
    }

    const allowedRoles = Array.isArray(p.allowedRoles) ? (p.allowedRoles as string[]).filter(r => typeof r === 'string') : undefined;
    const rateLimitPerUser = typeof p.rateLimitPerUser === 'number' && p.rateLimitPerUser > 0 ? p.rateLimitPerUser : undefined;

    validated[channelId] = {
      name: projectName,
      directory: p.directory,
      ...(p.idleTimeoutMs !== undefined && { idleTimeoutMs: Number(p.idleTimeoutMs) }),
      ...(Array.isArray(p.claudeArgs) && { claudeArgs: p.claudeArgs as string[] }),
      ...(projectAllowedEffective && { allowedTools: projectAllowedEffective }),
      ...(projectDisallowed && { disallowedTools: projectDisallowed }),
      ...(projectExtra && { extraAllowedTools: projectExtra }),
      ...(agents && { agents }),
      ...(allowedRoles && allowedRoles.length > 0 && { allowedRoles }),
      ...(rateLimitPerUser !== undefined && { rateLimitPerUser }),
      ...(typeof p.maxAttachmentSizeMb === 'number' && { maxAttachmentSizeMb: p.maxAttachmentSizeMb }),
      ...(Array.isArray(p.allowedMimeTypes) && { allowedMimeTypes: p.allowedMimeTypes as string[] }),
      ...(typeof p.maxAttachmentsPerMessage === 'number' && { maxAttachmentsPerMessage: p.maxAttachmentsPerMessage }),
    };
  }

  return {
    defaults: {
      idleTimeoutMs: typeof defaults.idleTimeoutMs === 'number' ? defaults.idleTimeoutMs : 1800000,
      maxConcurrentSessions: typeof defaults.maxConcurrentSessions === 'number' ? defaults.maxConcurrentSessions : 4,
      sessionTtlMs: typeof defaults.sessionTtlMs === 'number' ? defaults.sessionTtlMs : 7 * 24 * 60 * 60 * 1000,
      maxPersistedSessions: typeof defaults.maxPersistedSessions === 'number' ? defaults.maxPersistedSessions : 50,
      claudeArgs: Array.isArray(defaults.claudeArgs) ? (defaults.claudeArgs as string[]) : ['--permission-mode', 'acceptEdits', '--output-format', 'json'],
      allowedTools: effectiveDefaultAllowed,
      disallowedTools: defaultDisallowed,
      ...(defaultExtra && { extraAllowedTools: defaultExtra }),
      maxTurnsPerAgent: typeof defaults.maxTurnsPerAgent === 'number' ? defaults.maxTurnsPerAgent : 5,
      agentTimeoutMs: typeof defaults.agentTimeoutMs === 'number' ? defaults.agentTimeoutMs : 3 * 60 * 1000,
      stuckNotifyMs: typeof defaults.stuckNotifyMs === 'number' ? defaults.stuckNotifyMs : 300_000,
      httpPort: defaults.httpPort === false ? false : (typeof defaults.httpPort === 'number' ? defaults.httpPort : 3100),
      logLevel: isValidLogLevel(defaults.logLevel) ? defaults.logLevel : 'info',
      maxAttachmentSizeMb: typeof defaults.maxAttachmentSizeMb === 'number' ? defaults.maxAttachmentSizeMb : 10,
      allowedMimeTypes: Array.isArray(defaults.allowedMimeTypes) ? (defaults.allowedMimeTypes as string[]) : ['image/*', 'text/*', 'application/pdf', 'application/json'],
      maxAttachmentsPerMessage: typeof defaults.maxAttachmentsPerMessage === 'number' ? defaults.maxAttachmentsPerMessage : 5,
      persistence: defaults.persistence === 'tmux' ? 'tmux' : 'direct',
    },
    projects: validated,
  };
}

/**
 * Resolve timeout for a specific agent: agent-specific → global default.
 */
export function resolveAgentTimeout(agent: AgentConfig, defaults: GatewayDefaults): number {
  return agent.timeoutMs ?? defaults.agentTimeoutMs;
}
