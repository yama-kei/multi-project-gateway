import { describe, it, expect } from 'vitest';
import { loadExclusions, shouldExclude, type ExclusionConfig } from '../../src/ayumi/exclusions.js';

const testConfig: ExclusionConfig = {
  emails: ['noreply@example.com', 'spam@ads.com'],
  domains: ['marketing.example.com', 'newsletter.co'],
  labels: ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM'],
};

describe('exclusions', () => {
  describe('shouldExclude', () => {
    it('excludes by exact email match', () => {
      expect(shouldExclude(testConfig, { from: 'noreply@example.com', labelIds: [] })).toBe(true);
    });

    it('excludes by domain match', () => {
      expect(shouldExclude(testConfig, { from: 'anyone@marketing.example.com', labelIds: [] })).toBe(true);
    });

    it('excludes by label match', () => {
      expect(shouldExclude(testConfig, { from: 'friend@real.com', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] })).toBe(true);
    });

    it('does not exclude valid messages', () => {
      expect(shouldExclude(testConfig, { from: 'boss@work.com', labelIds: ['INBOX'] })).toBe(false);
    });

    it('handles case-insensitive email matching', () => {
      expect(shouldExclude(testConfig, { from: 'NoReply@Example.com', labelIds: [] })).toBe(true);
    });

    it('handles empty exclusion config', () => {
      const empty: ExclusionConfig = { emails: [], domains: [], labels: [] };
      expect(shouldExclude(empty, { from: 'anyone@any.com', labelIds: ['SPAM'] })).toBe(false);
    });
  });

  describe('loadExclusions', () => {
    it('loads the default exclusions.json', () => {
      const config = loadExclusions();
      expect(config).toHaveProperty('emails');
      expect(config).toHaveProperty('domains');
      expect(config).toHaveProperty('labels');
      expect(Array.isArray(config.emails)).toBe(true);
      expect(Array.isArray(config.domains)).toBe(true);
      expect(Array.isArray(config.labels)).toBe(true);
    });
  });
});
