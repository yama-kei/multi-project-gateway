import { describe, it, expect } from 'vitest';
import { PERSONA_PRESETS, resolvePreset } from '../src/persona-presets.js';

describe('persona-presets', () => {
  it('includes pm, engineer, qa, designer, devops presets', () => {
    expect(Object.keys(PERSONA_PRESETS)).toEqual(
      expect.arrayContaining(['pm', 'engineer', 'qa', 'designer', 'devops', 'curator']),
    );
  });

  it('each preset has role and prompt', () => {
    for (const [name, preset] of Object.entries(PERSONA_PRESETS)) {
      expect(preset.role).toBeTruthy();
      expect(preset.prompt).toBeTruthy();
    }
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
