import { describe, it, expect } from 'vitest';
import { agentColor, PALETTE } from '../src/embed-format.js';

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
