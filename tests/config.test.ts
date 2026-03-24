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

  it('loads persona config when present', () => {
    const raw = {
      projects: {
        '123': {
          name: 'pm',
          directory: '/tmp/proj',
          persona: {
            systemPrompt: 'You are a PM.',
            canMessageChannels: ['#engineer'],
            maxDirectivesPerTurn: 2,
          },
        },
      },
    };
    const config = loadConfig(raw);
    expect(config.projects['123'].persona).toEqual({
      systemPrompt: 'You are a PM.',
      canMessageChannels: ['#engineer'],
      maxDirectivesPerTurn: 2,
    });
  });

  it('defaults maxDirectivesPerTurn to 1 when persona present but field omitted', () => {
    const raw = {
      projects: {
        '123': {
          name: 'pm',
          directory: '/tmp/proj',
          persona: {
            systemPrompt: 'You are a PM.',
            canMessageChannels: ['#engineer'],
          },
        },
      },
    };
    const config = loadConfig(raw);
    expect(config.projects['123'].persona!.maxDirectivesPerTurn).toBe(1);
  });

  it('leaves persona undefined when not provided', () => {
    const raw = {
      projects: {
        '123': { name: 'Test', directory: '/tmp/test' },
      },
    };
    const config = loadConfig(raw);
    expect(config.projects['123'].persona).toBeUndefined();
  });

  it('applies default maxTurnsPerLink', () => {
    const raw = {
      projects: { '123': { name: 'Test', directory: '/tmp/test' } },
    };
    const config = loadConfig(raw);
    expect(config.defaults.maxTurnsPerLink).toBe(5);
  });

  it('reads maxTurnsPerLink from defaults', () => {
    const raw = {
      defaults: { maxTurnsPerLink: 10 },
      projects: { '123': { name: 'Test', directory: '/tmp/test' } },
    };
    const config = loadConfig(raw);
    expect(config.defaults.maxTurnsPerLink).toBe(10);
  });
});
