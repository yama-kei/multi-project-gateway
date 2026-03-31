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

import { createAdapter, type AdapterDeps } from '../src/create-adapter.js';
import { createDiscordBot } from '../src/discord.js';

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
});
