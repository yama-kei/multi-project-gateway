import { describe, it, expect } from 'vitest';
import { loadConfig, type GatewayConfig } from '../src/config.js';

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
});
