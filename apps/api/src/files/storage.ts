// Filesystem blob store (Slice C — Upload). No S3: 1 user, local-first, blobs
// live on the local disk under a configurable base dir (DATA_DIR).
//
// Path layout:  <DATA_DIR>/files/<projectId>/<uuid>-<sanitized-filename>
//
// DATA_DIR default: `./data` (resolved against process.cwd()). Override with the
// DATA_DIR env var. Tests point it at a throwaway OS temp dir.
//
// SECURITY — path traversal: the stored basename is derived ONLY from a freshly
// generated uuid plus a *sanitized* original filename. Sanitization strips every
// path separator and parent-dir segment (`..`), so a malicious upload named
// `../../../../etc/passwd` can never escape its project dir. We additionally
// assert the resolved absolute path stays within the project dir as defense in
// depth.

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

/** Base directory for all blobs. Env DATA_DIR, default `./data`. */
export function resolveDataDir(): string {
  return resolve(process.env.DATA_DIR ?? './data');
}

/**
 * Collapses an arbitrary (possibly hostile) upload filename to a safe, flat
 * basename with no directory component and no `..` segments. Keeps a readable
 * suffix so the stored blob is still recognizable, but is purely cosmetic — the
 * uuid prefix guarantees uniqueness.
 */
export function sanitizeFilename(original: string): string {
  // Take only the final path component (drops any directory the client sent,
  // using BOTH separators so a Windows-style `..\\..\\x` is handled too).
  const last = original.split(/[\\/]/).pop() ?? '';
  // Drop control chars + any remaining separators/`..`; keep a conservative set.
  const cleaned = last
    .replace(/\.\.+/g, '.') // collapse runs of dots (kills `..` traversal)
    .replace(/[^A-Za-z0-9._-]/g, '_') // allow-list; everything else -> `_`
    .replace(/^\.+/, '') // never let it start with a dot
    .slice(0, 180); // bound the length
  return cleaned.length > 0 ? cleaned : 'file';
}

export interface BlobStore {
  /** Absolute base dir (DATA_DIR) this store writes under. */
  readonly baseDir: string;
  /**
   * Persists `data` for `projectId` under a fresh unique path and returns the
   * absolute storage path. `originalName` is sanitized before use.
   */
  save(
    projectId: string,
    originalName: string,
    data: Buffer,
  ): Promise<string>;
  /** Opens a read stream over a previously saved blob. */
  openStream(storagePath: string): Readable;
}

class FilesystemBlobStore implements BlobStore {
  constructor(readonly baseDir: string) {}

  async save(
    projectId: string,
    originalName: string,
    data: Buffer,
  ): Promise<string> {
    const projectDir = resolve(this.baseDir, 'files', projectId);
    const safeName = `${randomUUID()}-${sanitizeFilename(originalName)}`;
    const target = resolve(projectDir, safeName);

    // Defense in depth: the resolved target MUST stay within projectDir. The
    // uuid + sanitized name make this structurally true; assert it anyway.
    if (target !== projectDir && !target.startsWith(projectDir + sep)) {
      throw new Error('resolved storage path escapes project directory');
    }
    // basename must be flat (no separators snuck through sanitization).
    if (basename(target) !== safeName) {
      throw new Error('unsafe storage filename');
    }

    await mkdir(projectDir, { recursive: true });
    await writeFile(target, data);
    return target;
  }

  openStream(storagePath: string): Readable {
    return createReadStream(storagePath);
  }
}

/** Builds a filesystem blob store rooted at DATA_DIR (env, default `./data`). */
export function createStorage(baseDir: string = resolveDataDir()): BlobStore {
  return new FilesystemBlobStore(baseDir);
}
