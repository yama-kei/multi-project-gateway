import { describe, it, expect, vi } from 'vitest';
import { agentColor, PALETTE, buildAgentEmbeds, buildHandoffEmbed, sendAgentMessage } from '../src/embed-format.js';

describe('agentColor', () => {
  it('returns the same color for the same key', () => {
    expect(agentColor('pm')).toBe(agentColor('pm'));
  });

  it('returns a value from the palette', () => {
    const color = agentColor('pm');
    expect(PALETTE).toContain(color);
  });

  it('returns different colors for different keys', () => {
    const colors = new Set(['pm', 'engineer', 'designer', 'qa', 'devops'].map(agentColor));
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });

  it('is case-sensitive (keys are pre-lowered by config)', () => {
    const a = agentColor('pm');
    const b = agentColor('PM');
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
  });
});

describe('buildAgentEmbeds', () => {
  it('returns a single embed for short text', () => {
    const embeds = buildAgentEmbeds('Hello world', 'pm', 'Product Manager');
    expect(embeds).toHaveLength(1);
    expect(embeds[0].data.description).toBe('Hello world');
    expect(embeds[0].data.author?.name).toBe('Product Manager');
    expect(embeds[0].data.color).toBe(agentColor('pm'));
  });

  it('chunks long text at 4096 characters', () => {
    const text = 'A'.repeat(5000);
    const embeds = buildAgentEmbeds(text, 'engineer', 'Engineer');
    expect(embeds).toHaveLength(2);
    expect(embeds[0].data.description).toHaveLength(4096);
    expect(embeds[0].data.author?.name).toBe('Engineer');
    expect(embeds[1].data.description).toHaveLength(904);
    expect(embeds[1].data.author?.name).toBe('Engineer (cont.)');
  });

  it('preserves color across all chunks', () => {
    const text = 'A'.repeat(9000);
    const embeds = buildAgentEmbeds(text, 'pm', 'Product Manager');
    const expectedColor = agentColor('pm');
    for (const embed of embeds) {
      expect(embed.data.color).toBe(expectedColor);
    }
  });

  it('handles empty text', () => {
    const embeds = buildAgentEmbeds('', 'pm', 'Product Manager');
    expect(embeds).toHaveLength(1);
    expect(embeds[0].data.description).toBe('');
    expect(embeds[0].data.author?.name).toBe('Product Manager');
  });
});

describe('buildHandoffEmbed', () => {
  it('creates an embed with the handoff message', () => {
    const embed = buildHandoffEmbed('engineer', 'Software Engineer');
    expect(embed.data.description).toBe('Handing off to **@engineer**...');
    expect(embed.data.author?.name).toBe('Software Engineer');
    expect(embed.data.color).toBe(agentColor('engineer'));
  });

  it('uses the correct agent color', () => {
    const embed = buildHandoffEmbed('pm', 'Product Manager');
    expect(embed.data.color).toBe(agentColor('pm'));
  });
});

function mockChannel() {
  const sent: unknown[] = [];
  return {
    send: vi.fn(async (content: unknown) => { sent.push(content); }),
    sent,
  };
}

describe('sendAgentMessage', () => {
  it('sends plain text when no agent is provided', async () => {
    const ch = mockChannel();
    await sendAgentMessage(ch as any, 'Hello world');
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]).toBe('Hello world');
  });

  it('sends embeds when agent is provided', async () => {
    const ch = mockChannel();
    await sendAgentMessage(ch as any, 'Hello world', 'pm', 'Product Manager');
    expect(ch.sent).toHaveLength(1);
    const msg = ch.sent[0] as { embeds: any[] };
    expect(msg.embeds).toHaveLength(1);
    expect(msg.embeds[0].data.author?.name).toBe('Product Manager');
  });

  it('sends multiple messages for long plain text (2000 limit)', async () => {
    const ch = mockChannel();
    await sendAgentMessage(ch as any, 'A'.repeat(4500));
    expect(ch.sent).toHaveLength(3); // 2000 + 2000 + 500
    expect(typeof ch.sent[0]).toBe('string');
  });

  it('sends multiple embed messages for long agent text (4096 limit)', async () => {
    const ch = mockChannel();
    await sendAgentMessage(ch as any, 'A'.repeat(5000), 'pm', 'Product Manager');
    expect(ch.sent).toHaveLength(2); // 4096 + 904
    const msg1 = ch.sent[0] as { embeds: any[] };
    const msg2 = ch.sent[1] as { embeds: any[] };
    expect(msg1.embeds[0].data.author?.name).toBe('Product Manager');
    expect(msg2.embeds[0].data.author?.name).toBe('Product Manager (cont.)');
  });
});
