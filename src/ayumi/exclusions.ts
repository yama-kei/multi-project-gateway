import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ExclusionConfig {
  emails: string[];
  domains: string[];
  labels: string[];
}

export interface ExcludableItem {
  from: string;
  labelIds: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadExclusions(path?: string): ExclusionConfig {
  const filePath = path ?? resolve(__dirname, 'config', 'exclusions.json');
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as ExclusionConfig;
}

export function shouldExclude(config: ExclusionConfig, item: ExcludableItem): boolean {
  const fromLower = item.from.toLowerCase();

  // Check exact email match
  if (config.emails.some((e) => fromLower === e.toLowerCase())) {
    return true;
  }

  // Check domain match
  const domain = fromLower.split('@')[1];
  if (domain && config.domains.some((d) => domain === d.toLowerCase())) {
    return true;
  }

  // Check label match
  if (config.labels.some((l) => item.labelIds.includes(l))) {
    return true;
  }

  return false;
}
