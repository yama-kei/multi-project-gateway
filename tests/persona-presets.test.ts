import { describe, it, expect } from 'vitest';
import { PERSONA_PRESETS, resolvePreset } from '../src/persona-presets.js';

describe('persona-presets', () => {
  it('includes pm, engineer, qa, designer, devops presets', () => {
    expect(Object.keys(PERSONA_PRESETS)).toEqual(
      expect.arrayContaining(['pm', 'engineer', 'qa', 'designer', 'devops']),
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

  it('resolvePreset returns undefined for unknown preset', () => {
    expect(resolvePreset('ceo')).toBeUndefined();
  });
});
