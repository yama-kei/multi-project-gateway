import { describe, it, expect, vi } from 'vitest';
import type { SessionManager } from '../src/session-manager.js';
import type { GatewayConfig } from '../src/config.js';

describe('handleCommand !help without ayumi', () => {
  it('does not include curator lines when ayumi is absent', async () => {
    // Mock the ayumi modules to simulate absence
    vi.doMock('../src/ayumi/curator-commands.js', () => {
      throw new Error('Cannot find module');
    });
    vi.doMock('../src/ayumi/index.js', () => {
      throw new Error('Cannot find module');
    });

    const { handleCommand } = await import('../src/discord.js');
    const config = { defaults: { claudeArgs: [] }, projects: {} } as unknown as GatewayConfig;
    const result = handleCommand('!help', config, {} as SessionManager);
    expect(result).toBeTruthy();
    expect(result).toContain('Gateway commands');
    expect(result).not.toContain('!curator');

    vi.doUnmock('../src/ayumi/curator-commands.js');
    vi.doUnmock('../src/ayumi/index.js');
  });
});

describe('handleCommand !help with ayumi', () => {
  it('includes curator lines when ayumi is present', async () => {
    // Mock ayumi curator-commands to simulate presence
    vi.doMock('../src/ayumi/curator-commands.js', () => ({
      handleCuratorCommand: async (_text: string) => null,
    }));

    // Re-import discord with ayumi mocked as present
    const { handleCommand } = await import('../src/discord.js?with-ayumi');
    const config = { defaults: { claudeArgs: [] }, projects: {} } as unknown as GatewayConfig;
    const result = handleCommand('!help', config, {} as SessionManager);
    expect(result).toBeTruthy();
    expect(result).toContain('!curator');

    vi.doUnmock('../src/ayumi/curator-commands.js');
  });
});
