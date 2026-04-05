import { describe, it, expect } from 'vitest';
import { PERSONA_PRESETS, resolvePreset } from '../src/persona-presets.js';

describe('persona-presets', () => {
  it('includes pm, engineer, qa, designer, devops, life-curator, and life-context presets', () => {
    expect(Object.keys(PERSONA_PRESETS)).toEqual(
      expect.arrayContaining([
        'pm', 'engineer', 'qa', 'designer', 'devops', 'life-curator',
        'life-work', 'life-travel', 'life-finance', 'life-health',
        'life-social', 'life-hobbies', 'life-router',
      ]),
    );
  });

  it('each preset has role and prompt', () => {
    for (const [name, preset] of Object.entries(PERSONA_PRESETS)) {
      expect(preset.role).toBeTruthy();
      expect(preset.prompt).toBeTruthy();
    }
  });

  describe('life-context topic agents', () => {
    const LIFE_PRESETS = ['life-work', 'life-travel', 'life-finance', 'life-health', 'life-social', 'life-hobbies'] as const;

    it('each references LIFE CONTEXT DATA section for knowledge source', () => {
      for (const name of LIFE_PRESETS) {
        expect(PERSONA_PRESETS[name].prompt).toContain('LIFE CONTEXT DATA');
      }
    });

    it('each instructs how to cite context and say when info is missing', () => {
      const TIER_12 = ['life-work', 'life-travel', 'life-social', 'life-hobbies'] as const;
      const TIER_3 = ['life-finance', 'life-health'] as const;

      for (const name of TIER_12) {
        expect(PERSONA_PRESETS[name].prompt).toContain('Cite specific details');
      }
      expect(PERSONA_PRESETS['life-finance'].prompt).toContain('Cite patterns and trends');
      expect(PERSONA_PRESETS['life-health'].prompt).toContain('Summarize patterns and timelines');
      for (const name of LIFE_PRESETS) {
        expect(PERSONA_PRESETS[name].prompt).toContain("don't have information");
      }
    });

    it('each instructs concise factual style', () => {
      for (const name of LIFE_PRESETS) {
        expect(PERSONA_PRESETS[name].prompt).toContain('concise and factual');
      }
    });
  });

  describe('life-router', () => {
    const router = PERSONA_PRESETS['life-router'];

    it('has the correct role', () => {
      expect(router.role).toBe('Life Context Router');
    });

    it('references all 6 topic agents and the curator', () => {
      expect(router.prompt).toContain('life-work');
      expect(router.prompt).toContain('life-travel');
      expect(router.prompt).toContain('life-finance');
      expect(router.prompt).toContain('life-health');
      expect(router.prompt).toContain('life-social');
      expect(router.prompt).toContain('life-hobbies');
      expect(router.prompt).toContain('life-curator');
    });

    it('includes HANDOFF dispatch instruction', () => {
      expect(router.prompt).toContain('HANDOFF @life-work:');
    });

    it('includes multi-topic fan-out instructions', () => {
      expect(router.prompt).toContain('multiple HANDOFF commands');
      expect(router.prompt).toContain('fan out');
    });

    it('includes fallback for off-topic queries', () => {
      expect(router.prompt).toContain('off-topic');
      expect(router.prompt).toContain('I can help with questions about your work, travel, finance, health, social life, and hobbies');
    });
  });

  describe('life-curator', () => {
    const curator = PERSONA_PRESETS['life-curator'];

    it('has contextPaths with all 6 topic authored.md files', () => {
      expect(curator.contextPaths).toEqual([
        'topics/work/authored.md',
        'topics/travel/authored.md',
        'topics/_sensitive/finance/authored.md',
        'topics/_sensitive/health/authored.md',
        'topics/social/authored.md',
        'topics/hobbies/authored.md',
      ]);
    });

    it('references !curator commands for approval flow', () => {
      expect(curator.prompt).toContain('!curator pending');
      expect(curator.prompt).toContain('!curator approve');
      expect(curator.prompt).toContain('!curator reject');
    });
  });

  it('resolvePreset returns matching preset (case-insensitive)', () => {
    expect(resolvePreset('PM')).toEqual(PERSONA_PRESETS.pm);
    expect(resolvePreset('Engineer')).toEqual(PERSONA_PRESETS.engineer);
    expect(resolvePreset('qa')).toEqual(PERSONA_PRESETS.qa);
  });

  it('pm prompt includes team management sections', () => {
    const pm = PERSONA_PRESETS.pm;
    expect(pm.prompt).toContain('## Team management');
    expect(pm.prompt).toContain('### Task decomposition');
    expect(pm.prompt).toContain('### Prioritization');
    expect(pm.prompt).toContain('### Status tracking');
    expect(pm.prompt).toContain('### Guiding the user');
  });

  it('resolvePreset returns undefined for unknown preset', () => {
    expect(resolvePreset('ceo')).toBeUndefined();
  });
});
