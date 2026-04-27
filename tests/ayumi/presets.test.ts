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
    'preset %s contains the shared connector instruction block',
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

  // The shared connector block is identical for all presets, so sampling one is sufficient
  // to assert its content (the per-preset propagation is already covered by the it.each tests above).
  it('preset prompts mention that read ops are pre-approved and writes need confirmation', () => {
    const prompt = AYUMI_PRESETS['life-router'].prompt;
    expect(prompt).toMatch(/pre-approved/i);
    expect(prompt).toMatch(/require user approval|confirm with the user/i);
  });
});

describe('life-curator broker → MCP migration', () => {
  const curator = AYUMI_PRESETS['life-curator'].prompt;

  it('removes all broker-API references from the prompt', () => {
    expect(curator).not.toContain('BROKER_URL');
    expect(curator).not.toContain('BROKER_API_SECRET');
    expect(curator).not.toContain('Broker API reference');
    expect(curator).not.toMatch(/POST \/broker\//);
    expect(curator).not.toContain('Do NOT use /mcp');
  });

  it('uses MCP tool references in the extraction pipeline', () => {
    expect(curator).toContain('mcp__claude_ai_Gmail__search_threads');
    expect(curator).toContain('mcp__claude_ai_Gmail__get_thread');
    expect(curator).toContain('mcp__claude_ai_Google_Calendar__list_events');
  });

  it('generalizes the no-Drive-writes rule to cover both broker and MCP Drive APIs', () => {
    expect(curator).toContain('vault-writer module handles ALL file writes');
    expect(curator).toMatch(
      /Do NOT use any external Drive API \(broker or mcp__claude_ai_Google_Drive__\*\)/,
    );
  });

  it('preserves the surrounding pipeline shape (Classify, Summarize, Write steps)', () => {
    expect(curator).toContain('## Gmail/Calendar extraction pipeline');
    expect(curator).toContain('**Classify**');
    expect(curator).toContain('**Summarize**');
    expect(curator).toContain('**Write**');
    expect(curator).toContain('vault-writer');
  });
});
