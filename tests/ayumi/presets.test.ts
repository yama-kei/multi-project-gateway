import { describe, it, expect } from 'vitest';
import { AYUMI_PRESETS } from '../../src/ayumi/presets.js';

const AYUMI_AGENT_NAMES = [
  'life-router',
  'life-work',
  'life-travel',
  'life-finance',
  'life-health',
  'life-social',
  'life-hobbies',
  'life-curator',
] as const;

describe('AYUMI_PRESETS connector instruction propagation', () => {
  it.each(AYUMI_AGENT_NAMES)(
    'preset %s ends with the shared connector instruction block',
    (name) => {
      const preset = AYUMI_PRESETS[name];
      expect(preset, `preset ${name} should exist`).toBeDefined();
      expect(preset.prompt).toContain(
        '## Tool access: Gmail / Google Calendar / Google Drive',
      );
    },
  );

  it.each(AYUMI_AGENT_NAMES)(
    'preset %s mentions ToolSearch and the three connector prefixes',
    (name) => {
      const prompt = AYUMI_PRESETS[name].prompt;
      expect(prompt).toContain('ToolSearch');
      expect(prompt).toContain('mcp__claude_ai_Gmail__');
      expect(prompt).toContain('mcp__claude_ai_Google_Calendar__');
      expect(prompt).toContain('mcp__claude_ai_Google_Drive__');
    },
  );

  it('preset prompts mention that read ops are pre-approved and writes need confirmation', () => {
    const prompt = AYUMI_PRESETS['life-router'].prompt;
    expect(prompt).toMatch(/pre-approved/i);
    expect(prompt).toMatch(/require user approval|confirm with the user/i);
  });
});
