/**
 * E2E-style tests for the life-router persona.
 * These verify that the router prompt, when combined with agent-dispatch parsing,
 * produces correct routing behavior for single and multi-topic queries.
 */
import { describe, it, expect } from 'vitest';
import { PERSONA_PRESETS } from '../../src/persona-presets.js';
import { parseHandoffCommand, parseAllHandoffs } from '../../src/agent-dispatch.js';

// All agents that the router can dispatch to must be registered
const ALL_AGENTS = Object.fromEntries(
  Object.entries(PERSONA_PRESETS).filter(([name]) => name.startsWith('life-')),
);

describe('life-router E2E', () => {
  describe('single-topic HANDOFF parsing', () => {
    it('routes a travel query to life-travel', () => {
      const routerOutput = 'HANDOFF @life-travel: Where did I travel last year?';
      const result = parseHandoffCommand(routerOutput, ALL_AGENTS);
      expect(result).not.toBeNull();
      expect(result!.agentName).toBe('life-travel');
      expect(result!.prompt).toContain('Where did I travel last year');
    });

    it('routes a work query to life-work', () => {
      const routerOutput = 'HANDOFF @life-work: What projects was I working on in January?';
      const result = parseHandoffCommand(routerOutput, ALL_AGENTS);
      expect(result).not.toBeNull();
      expect(result!.agentName).toBe('life-work');
    });

    it('routes a social query to life-social', () => {
      const routerOutput = 'HANDOFF @life-social: Who did I meet at the dinner last month?';
      const result = parseHandoffCommand(routerOutput, ALL_AGENTS);
      expect(result).not.toBeNull();
      expect(result!.agentName).toBe('life-social');
    });

    it('routes a hobbies query to life-hobbies', () => {
      const routerOutput = 'HANDOFF @life-hobbies: What sports events did I attend?';
      const result = parseHandoffCommand(routerOutput, ALL_AGENTS);
      expect(result).not.toBeNull();
      expect(result!.agentName).toBe('life-hobbies');
    });
  });

  describe('multi-topic fan-out parsing', () => {
    it('parses multiple HANDOFF lines into separate dispatches', () => {
      const routerOutput = [
        'HANDOFF @life-travel: What did I do last summer?',
        'HANDOFF @life-social: What did I do last summer?',
        'HANDOFF @life-hobbies: What did I do last summer?',
      ].join('\n');

      const results = parseAllHandoffs(routerOutput, ALL_AGENTS);
      expect(results).toHaveLength(3);
      expect(results.map(r => r.agentName)).toEqual(['life-travel', 'life-social', 'life-hobbies']);
    });

    it('single-topic query still works with parseAllHandoffs', () => {
      const routerOutput = 'HANDOFF @life-travel: Where did I fly to in March?';
      const results = parseAllHandoffs(routerOutput, ALL_AGENTS);
      expect(results).toHaveLength(1);
      expect(results[0].agentName).toBe('life-travel');
    });
  });

  describe('fallback behavior', () => {
    it('unmatched query does not produce a HANDOFF', () => {
      const routerOutput = 'I can help with questions about your work, travel, finance, health, social life, and hobbies.';
      const result = parseHandoffCommand(routerOutput, ALL_AGENTS);
      expect(result).toBeNull();
    });

    it('unmatched query produces empty array from parseAllHandoffs', () => {
      const routerOutput = 'I can help with questions about your work, travel, finance, health, social life, and hobbies.';
      const results = parseAllHandoffs(routerOutput, ALL_AGENTS);
      expect(results).toEqual([]);
    });
  });

  describe('router prompt structure', () => {
    const router = PERSONA_PRESETS['life-router'];

    it('instructs to dispatch via HANDOFF syntax', () => {
      expect(router.prompt).toMatch(/HANDOFF @life-work:/);
    });

    it('lists all six topics and curator as routing targets', () => {
      for (const topic of ['work', 'travel', 'finance', 'health', 'social', 'hobbies', 'curator']) {
        expect(router.prompt).toContain(`life-${topic}`);
      }
    });

    it('includes multi-topic dispatch instructions', () => {
      expect(router.prompt).toContain('multiple HANDOFF commands');
    });

    it('includes off-topic fallback', () => {
      expect(router.prompt).toContain('off-topic');
    });
  });
});
