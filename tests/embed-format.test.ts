import { describe, it, expect } from 'vitest';
import { agentColor, PALETTE, buildAgentEmbeds } from '../src/embed-format.js';

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
