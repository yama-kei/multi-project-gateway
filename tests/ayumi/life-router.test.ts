/**
 * E2E-style tests for the life-router persona.
 * These verify that the router prompt, when combined with agent-dispatch parsing,
 * produces correct routing behavior for single-topic queries.
 */
import { describe, it, expect } from 'vitest';
import { PERSONA_PRESETS } from '../../src/persona-presets.js';
import { parseHandoffCommand } from '../../src/agent-dispatch.js';

// All agents that the router can dispatch to must be registered
const ALL_AGENTS = Object.fromEntries(
  Object.entries(PERSONA_PRESETS).filter(([name]) => name.startsWith('life-')),
);

describe('life-router E2E', () => {
  describe('HANDOFF parsing for routed queries', () => {
    it('routes a travel query to life-travel', () => {
      // Simulate what the router agent would output
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

    it('routes multi-topic query to primary topic with secondary note', () => {
      const routerOutput = 'HANDOFF @life-travel: Where did I go with my running club? (may also relate to hobbies)';
      const result = parseHandoffCommand(routerOutput, ALL_AGENTS);
      expect(result).not.toBeNull();
      expect(result!.agentName).toBe('life-travel');
      expect(result!.prompt).toContain('may also relate to hobbies');
    });
  });

  describe('fallback behavior', () => {
    it('unmatched query does not produce a HANDOFF', () => {
      // When the router responds directly (no HANDOFF), parseHandoffCommand returns null
      const routerOutput = 'I can help with questions about your work, travel, social life, and hobbies. Could you rephrase your question to relate to one of these areas?';
      const result = parseHandoffCommand(routerOutput, ALL_AGENTS);
      expect(result).toBeNull();
    });
  });

  describe('router prompt structure', () => {
    const router = PERSONA_PRESETS['life-router'];

    it('instructs to dispatch via HANDOFF syntax that agent-dispatch can parse', () => {
      // The prompt tells the agent to use "HANDOFF @life-<topic>:" which matches
      // the parseHandoffCommand regex: /^HANDOFF\s+@<agent>\s*:\s*(.*)$/im
      expect(router.prompt).toMatch(/HANDOFF @life-/);
    });

    it('lists all four topics as dispatch targets', () => {
      const topics = ['work', 'travel', 'social', 'hobbies'];
      for (const topic of topics) {
        expect(router.prompt).toContain(`@life-${topic}`);
      }
    });

    it('instructs single-topic dispatch for multi-topic queries', () => {
      expect(router.prompt).toContain('PRIMARY topic');
      expect(router.prompt).toContain('secondary topics');
    });
  });
});
