import { mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Collection, Attachment } from 'discord.js';

export interface AttachmentConfig {
  maxAttachmentSizeMb: number;
  allowedMimeTypes: string[];
  maxAttachmentsPerMessage: number;
}

export const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = {
  maxAttachmentSizeMb: 10,
  allowedMimeTypes: ['image/*', 'text/*', 'application/pdf', 'application/json'],
  maxAttachmentsPerMessage: 5,
};

export interface DownloadedAttachment {
  path: string;
  name: string;
}

export interface AttachmentResult {
  downloaded: DownloadedAttachment[];
  warnings: string[];
}

function matchesMimeType(contentType: string | null, patterns: string[]): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.endsWith('/*')) {
      return mime.startsWith(pattern.slice(0, -1));
    }
    return mime === pattern;
  });
}

/**
 * Download Discord message attachments to a local directory.
 * Returns paths to downloaded files and any warnings for skipped files.
 */
export async function downloadAttachments(
  attachments: Collection<string, Attachment>,
  messageId: string,
  baseDir: string,
  config: AttachmentConfig,
): Promise<AttachmentResult> {
  const warnings: string[] = [];
  const downloaded: DownloadedAttachment[] = [];

  const items = [...attachments.values()];

  if (items.length > config.maxAttachmentsPerMessage) {
    warnings.push(
      `Only processing first ${config.maxAttachmentsPerMessage} of ${items.length} attachments.`,
    );
  }

  const toProcess = items.slice(0, config.maxAttachmentsPerMessage);
  const maxBytes = config.maxAttachmentSizeMb * 1024 * 1024;
  const dir = join(baseDir, '.mpg-attachments', messageId);

  let dirCreated = false;

  for (const att of toProcess) {
    const rawName = att.name ?? `attachment-${att.id}`;
    // Sanitize filename to prevent path traversal (e.g. "../../.env")
    const name = basename(rawName).replace(/^\.+/, '') || `attachment-${att.id}`;

    if (att.size > maxBytes) {
      warnings.push(`Skipped \`${name}\` — exceeds ${config.maxAttachmentSizeMb}MB limit.`);
      continue;
    }

    if (!matchesMimeType(att.contentType, config.allowedMimeTypes)) {
      warnings.push(`Skipped \`${name}\` — type \`${att.contentType ?? 'unknown'}\` not allowed.`);
      continue;
    }

    try {
      // Validate URL host to prevent SSRF against internal services
      const parsedUrl = new URL(att.url);
      if (!parsedUrl.hostname.endsWith('.discordapp.com') && !parsedUrl.hostname.endsWith('.discord.com')) {
        warnings.push(`Skipped \`${name}\` — untrusted URL host.`);
        continue;
      }

      const response = await fetch(att.url);
      if (!response.ok) {
        warnings.push(`Failed to download \`${name}\` — HTTP ${response.status}.`);
        continue;
      }

      if (!dirCreated) {
        await mkdir(dir, { recursive: true });
        dirCreated = true;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const filePath = join(dir, name);
      // Double-check resolved path stays within the attachment directory
      if (!resolve(filePath).startsWith(resolve(dir) + '/')) {
        warnings.push(`Skipped \`${rawName}\` — unsafe filename.`);
        continue;
      }
      await writeFile(filePath, buffer);
      downloaded.push({ path: filePath, name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to download \`${name}\` — ${msg}.`);
    }
  }

  return { downloaded, warnings };
}

/**
 * Build a prompt prefix describing attached files.
 */
export function buildAttachmentPrompt(attachments: DownloadedAttachment[]): string {
  if (attachments.length === 0) return '';
  const paths = attachments.map((a) => a.path).join('\n  ');
  return `[Attached files — use the Read tool to view these:\n  ${paths}]\n\n`;
}

/**
 * Remove the attachment directory for a given base dir.
 * Called during session cleanup.
 */
export async function cleanupAttachments(baseDir: string): Promise<void> {
  const dir = join(baseDir, '.mpg-attachments');
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — directory may not exist
  }
}
