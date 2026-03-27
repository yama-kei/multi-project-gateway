import { appendFileSync, renameSync, unlinkSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 5;

/**
 * Rotate a log file. Shifts .1 → .2 → ... → .maxFiles, then renames current → .1.
 * Files beyond maxFiles are deleted.
 */
export function rotateLog(logPath: string, maxFiles: number = DEFAULT_MAX_FILES): void {
  if (!existsSync(logPath)) return;

  // Delete the oldest if it would exceed maxFiles
  const oldest = `${logPath}.${maxFiles}`;
  if (existsSync(oldest)) {
    try { unlinkSync(oldest); } catch { /* ignore */ }
  }

  // Shift .N-1 → .N, .N-2 → .N-1, ...
  for (let i = maxFiles - 1; i >= 1; i--) {
    const from = `${logPath}.${i}`;
    const to = `${logPath}.${i + 1}`;
    if (existsSync(from)) {
      try { renameSync(from, to); } catch { /* ignore */ }
    }
  }

  // Rename current → .1
  try { renameSync(logPath, `${logPath}.1`); } catch { /* ignore */ }
}

/**
 * Create a writer function that appends lines to a log file.
 * Automatically rotates when the file exceeds maxBytes.
 */
export function createFileWriter(
  logPath: string,
  opts?: { maxBytes?: number; maxFiles?: number },
): (line: string) => void {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  let currentBytes = 0;

  // Ensure log directory exists
  const dir = dirname(logPath);
  mkdirSync(dir, { recursive: true });

  // Track current file size
  try {
    currentBytes = statSync(logPath).size;
  } catch {
    currentBytes = 0;
  }

  return (line: string) => {
    const data = line + '\n';
    const byteLength = Buffer.byteLength(data);

    if (currentBytes + byteLength > maxBytes && currentBytes > 0) {
      rotateLog(logPath, maxFiles);
      currentBytes = 0;
    }

    appendFileSync(logPath, data);
    currentBytes += byteLength;
  };
}
