import { describe, it, expect, vi } from 'vitest';
import { loadConfig, DEFAULT_ALLOWED_TOOLS, resolveAgentTimeout, type GatewayConfig, type GatewayDefaults, type AgentConfig } from '../src/config.js';
import { PERSONA_PRESETS } from '../src/persona-presets.js';

describe('loadConfig', () => {
  it('loads a valid config object', () => {
    const raw = {
      defaults: {
        idleTimeoutMs: 1800000,
        maxConcurrentSessions: 4,
        claudeArgs: ['--dangerously-skip-permissions', '--output-format', 'json'],
      },
      projects: {
        '123456789': {
          name: 'TestProject',
          directory: '/tmp/test-project',
        },
      },
    };
    const config = loadConfig(raw);
    expect(config.defaults.idleTimeoutMs).toBe(1800000);
    expect(config.defaults.maxConcurrentSessions).toBe(4);
    expect(config.projects['123456789'].name).toBe('TestProject');
    expect(config.projects['123456789'].directory).toBe('/tmp/test-project');
  });

  it('throws on missing projects field', () => {
    expect(() => loadConfig({ defaults: { idleTimeoutMs: 1000, maxConcurrentSessions: 4, claudeArgs: [] } } as any)).toThrow();
  });

  it('throws on missing directory in a project', () => {
    const raw = {
      defaults: { idleTimeoutMs: 1000, maxConcurrentSessions: 4, claudeArgs: [] },
      projects: { '123': { name: 'Test' } },
    };
    expect(() => loadConfig(raw as any)).toThrow();
  });

  it('loads projects with agents config', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          name: 'my-app',
          directory: '/tmp/app',
          agents: {
            pm: { role: 'Product Manager', prompt: 'You manage requirements.' },
            engineer: { role: 'Engineer', prompt: 'You write code.' },
          },
        },
      },
    });
    const project = config.projects['ch-1'];
    expect(project.agents).toBeDefined();
    expect(project.agents!.pm).toEqual({ role: 'Product Manager', prompt: 'You manage requirements.' });
    expect(project.agents!.engineer).toEqual({ role: 'Engineer', prompt: 'You write code.' });
  });

  it('loads projects without agents config (backward compatible)', () => {
    const config = loadConfig({
      projects: { 'ch-1': { name: 'Alpha', directory: '/tmp/a' } },
    });
    expect(config.projects['ch-1'].agents).toBeUndefined();
  });

  it('loads maxTurnsPerAgent default', () => {
    const config = loadConfig({ projects: { 'ch-1': { directory: '/tmp/a' } } });
    expect(config.defaults.maxTurnsPerAgent).toBe(5);
  });

  it('overrides maxTurnsPerAgent from config', () => {
    const config = loadConfig({
      defaults: { maxTurnsPerAgent: 10 },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.maxTurnsPerAgent).toBe(10);
  });

  it('normalizes agent names to lowercase', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            PM: { role: 'Product Manager', prompt: 'You manage.' },
            Engineer: { role: 'Engineer', prompt: 'You code.' },
          },
        },
      },
    });
    const agents = config.projects['ch-1'].agents!;
    expect(agents.pm).toBeDefined();
    expect(agents.engineer).toBeDefined();
    expect(agents.PM).toBeUndefined();
  });

  it('loads agentTimeoutMs default (3 minutes)', () => {
    const config = loadConfig({ projects: { 'ch-1': { directory: '/tmp/a' } } });
    expect(config.defaults.agentTimeoutMs).toBe(180000);
  });

  it('overrides agentTimeoutMs from config', () => {
    const config = loadConfig({
      defaults: { agentTimeoutMs: 60000 },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.agentTimeoutMs).toBe(60000);
  });

  it('applies default idleTimeoutMs when not specified', () => {
    const raw = {
      defaults: { maxConcurrentSessions: 4, claudeArgs: [] },
      projects: {
        '123': { name: 'Test', directory: '/tmp/test' },
      },
    };
    const config = loadConfig(raw as any);
    expect(config.defaults.idleTimeoutMs).toBe(1800000);
  });

  it('resolves agents from array shorthand using presets', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: ['pm', 'engineer', 'qa'],
        },
      },
    });
    const agents = config.projects['ch-1'].agents!;
    expect(agents.pm).toEqual(PERSONA_PRESETS.pm);
    expect(agents.engineer).toEqual(PERSONA_PRESETS.engineer);
    expect(agents.qa).toEqual(PERSONA_PRESETS.qa);
  });

  it('ignores unknown preset names in array shorthand', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: ['pm', 'nonexistent'],
        },
      },
    });
    const agents = config.projects['ch-1'].agents!;
    expect(agents.pm).toBeDefined();
    expect(agents.nonexistent).toBeUndefined();
  });

  it('resolves preset field in object-form agents', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            pm: { preset: 'pm' },
          },
        },
      },
    });
    const agents = config.projects['ch-1'].agents!;
    expect(agents.pm.role).toBe('Product Manager');
    expect(agents.pm.prompt).toBe(PERSONA_PRESETS.pm.prompt);
  });

  it('appends user prompt to preset base prompt', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            engineer: { preset: 'engineer', prompt: 'This is a TypeScript monorepo.' },
          },
        },
      },
    });
    const agent = config.projects['ch-1'].agents!.engineer;
    expect(agent.prompt).toContain(PERSONA_PRESETS.engineer.prompt);
    expect(agent.prompt).toContain('This is a TypeScript monorepo.');
    expect(agent.prompt).toBe(`${PERSONA_PRESETS.engineer.prompt}\n\nThis is a TypeScript monorepo.`);
  });

  it('allows role override with preset', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            pm: { preset: 'pm', role: 'Tech Lead' },
          },
        },
      },
    });
    expect(config.projects['ch-1'].agents!.pm.role).toBe('Tech Lead');
  });

  it('inline agents still work alongside preset agents (backward compatible)', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            pm: { preset: 'pm' },
            custom: { role: 'Custom Agent', prompt: 'You do custom things.' },
          },
        },
      },
    });
    const agents = config.projects['ch-1'].agents!;
    expect(agents.pm.role).toBe('Product Manager');
    expect(agents.custom).toEqual({ role: 'Custom Agent', prompt: 'You do custom things.' });
  });

  it('returns undefined agents when array shorthand has only unknown presets', () => {
    const config = loadConfig({
      projects: {
        'ch-1': { directory: '/tmp/app', agents: ['unknown1', 'unknown2'] },
      },
    });
    expect(config.projects['ch-1'].agents).toBeUndefined();
  });

  it('defaults httpPort to 3100', () => {
    const config = loadConfig({ projects: { 'ch-1': { directory: '/tmp/a' } } });
    expect(config.defaults.httpPort).toBe(3100);
  });

  it('overrides httpPort from config', () => {
    const config = loadConfig({
      defaults: { httpPort: 8080 },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.httpPort).toBe(8080);
  });

  it('disables httpPort when set to false', () => {
    const config = loadConfig({
      defaults: { httpPort: false },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.httpPort).toBe(false);
  });

  // --- allowedTools / disallowedTools ---

  it('applies DEFAULT_ALLOWED_TOOLS when no tools config specified', () => {
    const config = loadConfig({
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(config.defaults.disallowedTools).toEqual([]);
  });

  it('overrides default allowedTools from config', () => {
    const config = loadConfig({
      defaults: { allowedTools: ['Read', 'Bash'] },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('loads disallowedTools from defaults', () => {
    const config = loadConfig({
      defaults: { disallowedTools: ['Bash', 'WebSearch'] },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.disallowedTools).toEqual(['Bash', 'WebSearch']);
    // allowedTools still gets defaults since not overridden
    expect(config.defaults.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it('warns when both allowedTools and disallowedTools are set in defaults', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({
      defaults: { allowedTools: ['Read'], disallowedTools: ['Bash'] },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('gateway defaults set both allowedTools and disallowedTools')
    );
    warnSpy.mockRestore();
  });

  it('loads per-project allowedTools', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/a',
          allowedTools: ['Read', 'Edit', 'Bash'],
        },
      },
    });
    expect(config.projects['ch-1'].allowedTools).toEqual(['Read', 'Edit', 'Bash']);
  });

  it('loads per-project disallowedTools', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/a',
          disallowedTools: ['WebSearch'],
        },
      },
    });
    expect(config.projects['ch-1'].disallowedTools).toEqual(['WebSearch']);
  });

  it('warns when project sets both allowedTools and disallowedTools', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({
      projects: {
        'ch-1': {
          name: 'TestProj',
          directory: '/tmp/a',
          allowedTools: ['Read'],
          disallowedTools: ['Bash'],
        },
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('project "TestProj" sets both allowedTools and disallowedTools')
    );
    warnSpy.mockRestore();
  });

  // --- extraAllowedTools ---

  it('extends DEFAULT_ALLOWED_TOOLS when only defaults.extraAllowedTools is set', () => {
    const config = loadConfig({
      defaults: { extraAllowedTools: ['WebFetch'] },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS, 'WebFetch']);
  });

  it('extends explicit defaults.allowedTools when defaults.extraAllowedTools is also set', () => {
    const config = loadConfig({
      defaults: {
        allowedTools: ['Read', 'Bash'],
        extraAllowedTools: ['WebFetch'],
      },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual(['Read', 'Bash', 'WebFetch']);
  });

  it('layers project.extraAllowedTools on top of effective defaults when project.allowedTools is absent', () => {
    const config = loadConfig({
      defaults: { extraAllowedTools: ['WebFetch'] },
      projects: {
        'ch-1': {
          directory: '/tmp/a',
          extraAllowedTools: ['WebSearch'],
        },
      },
    });
    expect(config.projects['ch-1'].allowedTools).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'WebFetch',
      'WebSearch',
    ]);
  });

  it('extends project.allowedTools with project.extraAllowedTools', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/a',
          allowedTools: ['Read', 'Glob'],
          extraAllowedTools: ['WebFetch'],
        },
      },
    });
    expect(config.projects['ch-1'].allowedTools).toEqual(['Read', 'Glob', 'WebFetch']);
  });

  it('deduplicates overlapping entries and preserves first-occurrence order', () => {
    const config = loadConfig({
      defaults: {
        allowedTools: ['Read', 'Edit', 'Glob'],
        // "Read" overlaps with base, and "WebFetch" appears twice in extra
        extraAllowedTools: ['Read', 'WebFetch', 'WebFetch'],
      },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual(['Read', 'Edit', 'Glob', 'WebFetch']);
  });

  it('warns and drops disallowedTools when defaults set extraAllowedTools + disallowedTools', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({
      defaults: {
        extraAllowedTools: ['WebFetch'],
        disallowedTools: ['Bash'],
      },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('gateway defaults set both extraAllowedTools and disallowedTools')
    );
    expect(config.defaults.disallowedTools).toEqual([]);
    expect(config.defaults.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS, 'WebFetch']);
    warnSpy.mockRestore();
  });

  it('does not warn about extraAllowedTools + disallowedTools when allowedTools is also set (existing warning covers it)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({
      defaults: {
        allowedTools: ['Read'],
        extraAllowedTools: ['WebFetch'],
        disallowedTools: ['Bash'],
      },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    const calls = warnSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(m => m.includes('allowedTools and disallowedTools'))).toBe(true);
    expect(calls.some(m => m.includes('extraAllowedTools and disallowedTools'))).toBe(false);
    warnSpy.mockRestore();
  });

  it('warns and drops disallowedTools when project sets extraAllowedTools + disallowedTools', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({
      projects: {
        'ch-1': {
          name: 'Alpha',
          directory: '/tmp/a',
          extraAllowedTools: ['WebFetch'],
          disallowedTools: ['Bash'],
        },
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('project "Alpha" sets both extraAllowedTools and disallowedTools')
    );
    expect(config.projects['ch-1'].disallowedTools).toBeUndefined();
    expect(config.projects['ch-1'].allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS, 'WebFetch']);
    warnSpy.mockRestore();
  });

  it('ignores non-array extraAllowedTools and emits a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({
      defaults: { extraAllowedTools: 'WebFetch' as any },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('defaults.extraAllowedTools must be an array of strings')
    );
    expect(config.defaults.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    warnSpy.mockRestore();
  });

  it('filters non-string entries from extraAllowedTools', () => {
    const config = loadConfig({
      defaults: { extraAllowedTools: ['WebFetch', 123, null, 'WebSearch'] as any },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'WebFetch',
      'WebSearch',
    ]);
  });

  it('treats an empty extraAllowedTools array as absent', () => {
    const config = loadConfig({
      defaults: { extraAllowedTools: [] },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(config.defaults.extraAllowedTools).toBeUndefined();
  });

  it('leaves behavior unchanged when extraAllowedTools is absent', () => {
    const config = loadConfig({
      defaults: { allowedTools: ['Read', 'Bash'] },
      projects: { 'ch-1': { directory: '/tmp/a', allowedTools: ['Read'] } },
    });
    expect(config.defaults.allowedTools).toEqual(['Read', 'Bash']);
    expect(config.projects['ch-1'].allowedTools).toEqual(['Read']);
  });

  it('ignores non-array project.extraAllowedTools and emits a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({
      projects: {
        'ch-1': {
          name: 'Alpha',
          directory: '/tmp/a',
          extraAllowedTools: 'WebFetch' as any,
        },
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('project "Alpha".extraAllowedTools must be an array of strings')
    );
    expect(config.projects['ch-1'].allowedTools).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('merges all three of project.allowedTools, extraAllowedTools, and disallowedTools without the extra+disallowed warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({
      projects: {
        'ch-1': {
          name: 'Alpha',
          directory: '/tmp/a',
          allowedTools: ['Read'],
          extraAllowedTools: ['WebFetch'],
          disallowedTools: ['Bash'],
        },
      },
    });
    const calls = warnSpy.mock.calls.map(c => String(c[0]));
    // The existing allowedTools+disallowedTools warning fires:
    expect(calls.some(m => m.includes('project "Alpha" sets both allowedTools and disallowedTools'))).toBe(true);
    // The extraAllowedTools+disallowedTools warning does NOT fire:
    expect(calls.some(m => m.includes('extraAllowedTools and disallowedTools'))).toBe(false);
    // Merged allowedTools is allowedTools ∪ extraAllowedTools:
    expect(config.projects['ch-1'].allowedTools).toEqual(['Read', 'WebFetch']);
    // disallowedTools is preserved (runtime still prefers allowedTools):
    expect(config.projects['ch-1'].disallowedTools).toEqual(['Bash']);
    warnSpy.mockRestore();
  });

  // --- logLevel ---

  it('defaults logLevel to info', () => {
    const config = loadConfig({ projects: { 'ch-1': { directory: '/tmp/a' } } });
    expect(config.defaults.logLevel).toBe('info');
  });

  it('overrides logLevel from config', () => {
    const config = loadConfig({
      defaults: { logLevel: 'debug' },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.logLevel).toBe('debug');
  });

  it('falls back to info for invalid logLevel', () => {
    const config = loadConfig({
      defaults: { logLevel: 'verbose' },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.logLevel).toBe('info');
  });

  it('omits allowedTools/disallowedTools from project when not specified', () => {
    const config = loadConfig({
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.projects['ch-1'].allowedTools).toBeUndefined();
    expect(config.projects['ch-1'].disallowedTools).toBeUndefined();
  });

  // --- allowedRoles / rateLimitPerUser ---

  it('loads allowedRoles from project config', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/a',
          allowedRoles: ['admin', 'developer', '123456789'],
        },
      },
    });
    expect(config.projects['ch-1'].allowedRoles).toEqual(['admin', 'developer', '123456789']);
  });

  it('omits allowedRoles when not specified (backward compatible)', () => {
    const config = loadConfig({
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.projects['ch-1'].allowedRoles).toBeUndefined();
  });

  it('omits allowedRoles when empty array', () => {
    const config = loadConfig({
      projects: { 'ch-1': { directory: '/tmp/a', allowedRoles: [] } },
    });
    expect(config.projects['ch-1'].allowedRoles).toBeUndefined();
  });

  it('filters non-string entries from allowedRoles', () => {
    const config = loadConfig({
      projects: {
        'ch-1': { directory: '/tmp/a', allowedRoles: ['admin', 123, null, 'dev'] as any },
      },
    });
    expect(config.projects['ch-1'].allowedRoles).toEqual(['admin', 'dev']);
  });

  it('loads rateLimitPerUser from project config', () => {
    const config = loadConfig({
      projects: {
        'ch-1': { directory: '/tmp/a', rateLimitPerUser: 5 },
      },
    });
    expect(config.projects['ch-1'].rateLimitPerUser).toBe(5);
  });

  it('omits rateLimitPerUser when not specified', () => {
    const config = loadConfig({
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.projects['ch-1'].rateLimitPerUser).toBeUndefined();
  });

  it('omits rateLimitPerUser when zero or negative', () => {
    const config = loadConfig({
      projects: { 'ch-1': { directory: '/tmp/a', rateLimitPerUser: 0 } },
    });
    expect(config.projects['ch-1'].rateLimitPerUser).toBeUndefined();

    const config2 = loadConfig({
      projects: { 'ch-1': { directory: '/tmp/a', rateLimitPerUser: -1 } },
    });
    expect(config2.projects['ch-1'].rateLimitPerUser).toBeUndefined();
  });

  // --- persistence ---

  it('defaults persistence to direct', () => {
    const config = loadConfig({ projects: { 'ch-1': { directory: '/tmp/a' } } });
    expect(config.defaults.persistence).toBe('direct');
  });

  it('accepts persistence: tmux', () => {
    const config = loadConfig({
      defaults: { persistence: 'tmux' },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.persistence).toBe('tmux');
  });

  it('falls back to direct for invalid persistence value', () => {
    const config = loadConfig({
      defaults: { persistence: 'docker' },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.persistence).toBe('direct');
  });

  // --- per-agent timeoutMs ---

  it('parses per-agent timeoutMs from inline agent config', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            engineer: { role: 'Engineer', prompt: 'You write code.', timeoutMs: 1800000 },
            pm: { role: 'PM', prompt: 'You manage.', timeoutMs: 300000 },
          },
        },
      },
    });
    expect(config.projects['ch-1'].agents!.engineer.timeoutMs).toBe(1800000);
    expect(config.projects['ch-1'].agents!.pm.timeoutMs).toBe(300000);
  });

  it('parses per-agent timeoutMs from preset-based agent config', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            engineer: { preset: 'engineer', timeoutMs: 900000 },
          },
        },
      },
    });
    expect(config.projects['ch-1'].agents!.engineer.timeoutMs).toBe(900000);
  });

  it('omits timeoutMs when not specified in agent config', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            pm: { role: 'PM', prompt: 'You manage.' },
          },
        },
      },
    });
    expect(config.projects['ch-1'].agents!.pm.timeoutMs).toBeUndefined();
  });

  it('ignores non-positive timeoutMs values', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            pm: { role: 'PM', prompt: 'You manage.', timeoutMs: 0 },
            engineer: { role: 'Engineer', prompt: 'You code.', timeoutMs: -1 },
          },
        },
      },
    });
    expect(config.projects['ch-1'].agents!.pm.timeoutMs).toBeUndefined();
    expect(config.projects['ch-1'].agents!.engineer.timeoutMs).toBeUndefined();
  });

  it('ignores non-number timeoutMs values', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/app',
          agents: {
            pm: { role: 'PM', prompt: 'You manage.', timeoutMs: 'fast' },
          },
        },
      },
    });
    expect(config.projects['ch-1'].agents!.pm.timeoutMs).toBeUndefined();
  });
});

describe('resolveAgentTimeout', () => {
  const defaults = { agentTimeoutMs: 180000 } as GatewayDefaults;

  it('returns agent-specific timeout when set', () => {
    const agent: AgentConfig = { role: 'Engineer', prompt: 'code', timeoutMs: 1800000 };
    expect(resolveAgentTimeout(agent, defaults)).toBe(1800000);
  });

  it('falls back to global default when agent has no timeoutMs', () => {
    const agent: AgentConfig = { role: 'PM', prompt: 'manage' };
    expect(resolveAgentTimeout(agent, defaults)).toBe(180000);
  });
});
