import { describe, it, expect } from 'vitest';
import { summarizeTopic, applyWikilinks, type TopicSummaryResult } from '../../src/ayumi/topic-summarizer.js';
import type { ClassifiedItem } from '../../src/ayumi/extraction-pipeline.js';

function makeItem(overrides: Partial<ClassifiedItem> = {}): ClassifiedItem {
  return {
    sourceId: 'msg1',
    source: 'gmail',
    topic: 'work',
    tier: 2,
    subject: 'Q4 Review',
    date: '2026-01-15T10:00:00Z',
    from: 'boss@work.com',
    snippet: 'Please review the Q4 report attached',
    body: 'Full email body about Q4 performance review and goals for next quarter.',
    ...overrides,
  };
}

describe('summarizeTopic', () => {
  it('generates summary.md, timeline.md, entities.md for tier 1 topics', () => {
    const items: ClassifiedItem[] = [
      makeItem({ topic: 'travel', tier: 1, subject: 'Flight to Tokyo', from: 'airlines@flight.com', date: '2026-02-01T08:00:00Z', snippet: 'Your flight JAL123 to Tokyo is confirmed' }),
      makeItem({ topic: 'travel', tier: 1, subject: 'Hotel Reservation', from: 'hotel@booking.com', date: '2026-02-01T12:00:00Z', snippet: 'Reservation at Grand Hyatt Tokyo confirmed' }),
    ];

    const result = summarizeTopic('travel', items);

    expect(result.topic).toBe('travel');
    expect(result.files).toHaveProperty('summary');
    expect(result.files).toHaveProperty('timeline');
    expect(result.files).toHaveProperty('entities');
    expect(result.files.summary).toContain('# Travel — Summary');
    expect(result.files.timeline).toContain('# Travel — Timeline');
    expect(result.files.entities).toContain('# Travel — Entities');
  });

  it('generates summary.md, timeline.md, entities.md for tier 2 topics', () => {
    const items: ClassifiedItem[] = [makeItem()];
    const result = summarizeTopic('work', items);

    expect(result.files).toHaveProperty('summary');
    expect(result.files).toHaveProperty('timeline');
    expect(result.files).toHaveProperty('entities');
  });

  it('generates summary.md only for tier 3 topics', () => {
    const items: ClassifiedItem[] = [
      makeItem({ topic: 'health', tier: 3, subject: 'Lab Results', from: 'clinic@health.com', snippet: 'Your lab results are ready' }),
    ];

    const result = summarizeTopic('health', items);

    expect(result.files).toHaveProperty('summary');
    expect(result.files.timeline).toBeUndefined();
    expect(result.files.entities).toBeUndefined();
    expect(result.files.summary).toContain('# Health — Summary');
    // Tier 3: should NOT contain specific details from snippet
    expect(result.files.summary).not.toContain('Lab Results');
  });

  it('produces requiresApproval=true for tier 3 topics', () => {
    const items: ClassifiedItem[] = [
      makeItem({ topic: 'finance', tier: 3 }),
    ];

    const result = summarizeTopic('finance', items);

    expect(result.requiresApproval).toBe(true);
  });

  it('produces requiresApproval=false for tier 1-2 topics', () => {
    const items: ClassifiedItem[] = [makeItem({ topic: 'work', tier: 2 })];
    const result = summarizeTopic('work', items);
    expect(result.requiresApproval).toBe(false);
  });

  it('handles empty item list', () => {
    const result = summarizeTopic('travel', []);
    expect(result.files.summary).toContain('No items');
  });

  it('does not return entities for tier 3 topics', () => {
    const items: ClassifiedItem[] = [
      makeItem({ topic: 'finance', tier: 3 }),
    ];
    const result = summarizeTopic('finance', items);
    expect(result.entities).toBeUndefined();
  });

  it('returns entity info for tier 1-2 topics', () => {
    const items: ClassifiedItem[] = [
      makeItem({ from: 'tanaka.kenji@company.com' }),
      makeItem({ from: 'suzuki.yui@company.com' }),
      makeItem({ from: 'tanaka.kenji@company.com', sourceId: 'msg2' }),
    ];

    const result = summarizeTopic('work', items);

    expect(result.entities).toBeDefined();
    expect(result.entities!.length).toBe(2);

    const tanaka = result.entities!.find((e) => e.name === 'Tanaka Kenji');
    expect(tanaka).toBeDefined();
    expect(tanaka!.type).toBe('person');
    expect(tanaka!.aliases).toContain('tanaka.kenji@company.com');

    const suzuki = result.entities!.find((e) => e.name === 'Suzuki Yui');
    expect(suzuki).toBeDefined();
  });

  it('generates wikilinks in entities.md table', () => {
    const items: ClassifiedItem[] = [
      makeItem({ from: 'tanaka.kenji@company.com' }),
    ];

    const result = summarizeTopic('work', items);

    expect(result.files.entities).toContain('[[Tanaka Kenji]]');
  });
});

describe('applyWikilinks', () => {
  it('wraps known entity names in [[wikilinks]]', () => {
    const entities = new Set(['Tanaka Kenji', 'Project Aurora']);
    const text = 'Met with Tanaka Kenji to discuss Project Aurora.';
    const result = applyWikilinks(text, entities);
    expect(result).toBe('Met with [[Tanaka Kenji]] to discuss [[Project Aurora]].');
  });

  it('does not double-link already linked names', () => {
    const entities = new Set(['Tanaka Kenji']);
    const text = 'Met with [[Tanaka Kenji]] today.';
    const result = applyWikilinks(text, entities);
    expect(result).toBe('Met with [[Tanaka Kenji]] today.');
  });

  it('does not link partial matches', () => {
    const entities = new Set(['Tanaka Kenji']);
    const text = 'TanakaKenji is not a match.';
    const result = applyWikilinks(text, entities);
    expect(result).not.toContain('[[');
  });

  it('handles empty entity set', () => {
    const text = 'No entities here.';
    const result = applyWikilinks(text, new Set());
    expect(result).toBe(text);
  });
});
