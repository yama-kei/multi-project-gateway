import { describe, it, expect } from 'vitest';
import { PERSONA_PRESETS, resolvePreset } from '../src/persona-presets.js';

describe('persona-presets', () => {
  it('includes pm, engineer, qa, designer, devops, curator, and life-context presets', () => {
    expect(Object.keys(PERSONA_PRESETS)).toEqual(
      expect.arrayContaining([
        'pm', 'engineer', 'qa', 'designer', 'devops', 'curator',
        'life-work', 'life-travel', 'life-social', 'life-hobbies',
        'life-router',
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
    const LIFE_PRESETS = ['life-work', 'life-travel', 'life-social', 'life-hobbies'] as const;

    it('each has contextPaths pointing to summary, timeline, and entities', () => {
      for (const name of LIFE_PRESETS) {
        const preset = PERSONA_PRESETS[name];
        expect(preset.contextPaths).toBeDefined();
        expect(preset.contextPaths).toHaveLength(3);
        const topic = name.replace('life-', '');
        expect(preset.contextPaths).toEqual([
          `/life-context/${topic}/summary.md`,
          `/life-context/${topic}/timeline.md`,
          `/life-context/${topic}/entities.md`,
        ]);
      }
    });

    it('tier 1 agents (travel, hobbies) mention sharing freely', () => {
      for (const name of ['life-travel', 'life-hobbies'] as const) {
        expect(PERSONA_PRESETS[name].prompt).toContain('Tier 1');
        expect(PERSONA_PRESETS[name].prompt).toContain('freely');
      }
    });

    it('tier 2 agents (work, social) mention caution with sensitive details', () => {
      for (const name of ['life-work', 'life-social'] as const) {
        expect(PERSONA_PRESETS[name].prompt).toContain('Tier 2');
        expect(PERSONA_PRESETS[name].prompt).toContain('do not volunteer');
      }
    });

    it('each instructs to say "I don\'t have information" when context is missing', () => {
      for (const name of LIFE_PRESETS) {
        expect(PERSONA_PRESETS[name].prompt).toContain("I don't have information about that");
      }
    });
  });

  describe('life-router', () => {
    const router = PERSONA_PRESETS['life-router'];

    it('has the correct role', () => {
      expect(router.role).toBe('Life Context Router');
    });

    it('references all 4 topic agents', () => {
      expect(router.prompt).toContain('@life-work');
      expect(router.prompt).toContain('@life-travel');
      expect(router.prompt).toContain('@life-social');
      expect(router.prompt).toContain('@life-hobbies');
    });

    it('includes HANDOFF dispatch instruction', () => {
      expect(router.prompt).toContain('HANDOFF @life-<topic>:');
    });

    it('includes fallback instructions for unmatched queries', () => {
      expect(router.prompt).toContain('does not match any of the four topics');
      expect(router.prompt).toContain('Could you rephrase');
    });

    it('does not have contextPaths (router does not load Drive files)', () => {
      expect(router.contextPaths).toBeUndefined();
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
