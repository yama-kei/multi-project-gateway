// tests/create-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock discord.ts so we don't need a real Discord client
vi.mock('../src/discord.js', () => ({
  createDiscordBot: vi.fn(() => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    getStatus: vi.fn(() => 'connected'),
    deliverOrphanResult: vi.fn(async () => {}),
  })),
}));

// Mock slack.ts so we don't need real Slack credentials
vi.mock('../src/slack.js', () => ({
  createSlackBot: vi.fn(() => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    getStatus: vi.fn(() => 'connected'),
    deliverOrphanResult: vi.fn(async () => {}),
  })),
}));

import { createAdapter, type AdapterDeps } from '../src/create-adapter.js';
import { createDiscordBot } from '../src/discord.js';
import { createSlackBot } from '../src/slack.js';

function makeDeps(overrides?: Partial<AdapterDeps>): AdapterDeps {
  return {
    token: 'test-token',
    router: {} as any,
    sessionManager: {} as any,
    config: { defaults: {}, projects: {} } as any,
    turnCounter: undefined,
    ...overrides,
  };
}

describe('createAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CHAT_PLATFORM;
  });

  it('returns a discord adapter by default (no CHAT_PLATFORM set)', () => {
    const adapter = createAdapter(makeDeps());
    expect(createDiscordBot).toHaveBeenCalledWith(
      'test-token',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
    );
    expect(adapter.start).toBeTypeOf('function');
  });

  it('returns a discord adapter when CHAT_PLATFORM=discord', () => {
    process.env.CHAT_PLATFORM = 'discord';
    const adapter = createAdapter(makeDeps());
    expect(createDiscordBot).toHaveBeenCalled();
    expect(adapter.getStatus).toBeTypeOf('function');
  });

  it('respects platform field in deps over env var', () => {
    process.env.CHAT_PLATFORM = 'telegram';
    const adapter = createAdapter(makeDeps({ platform: 'discord' }));
    expect(createDiscordBot).toHaveBeenCalled();
    expect(adapter.start).toBeTypeOf('function');
  });

  it('throws for unsupported platform', () => {
    expect(() => createAdapter(makeDeps({ platform: 'telegram' }))).toThrow(
      'Unsupported CHAT_PLATFORM: telegram',
    );
  });

  it('returns a slack adapter when platform=slack with appToken', () => {
    const adapter = createAdapter(makeDeps({ platform: 'slack', slackAppToken: 'xapp-test' }));
    expect(createSlackBot).toHaveBeenCalledWith(
      'test-token',
      'xapp-test',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
    );
    expect(adapter.start).toBeTypeOf('function');
  });

  it('reads SLACK_APP_TOKEN from env when slackAppToken not provided', () => {
    process.env.SLACK_APP_TOKEN = 'xapp-from-env';
    const adapter = createAdapter(makeDeps({ platform: 'slack' }));
    expect(createSlackBot).toHaveBeenCalledWith(
      'test-token',
      'xapp-from-env',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
    );
    expect(adapter.start).toBeTypeOf('function');
    delete process.env.SLACK_APP_TOKEN;
  });

  it('throws when platform=slack but no app token provided', () => {
    delete process.env.SLACK_APP_TOKEN;
    expect(() => createAdapter(makeDeps({ platform: 'slack' }))).toThrow(
      'SLACK_APP_TOKEN is required',
    );
  });

  it('error message lists both discord and slack as supported', () => {
    expect(() => createAdapter(makeDeps({ platform: 'telegram' }))).toThrow(
      /Supported: discord, slack/,
    );
  });
});
