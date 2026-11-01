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
// assert the resolved absolute path stays within the fixed, trusted
// `<DATA_DIR>/files` root (NOT the per-project dir, which is itself derived from
// the untrusted projectId) as defense in depth — a hostile projectId like
// `../../../../tmp/evil` is caught here and the projectId is also asserted to be
// a UUID before it is used as a path segment.

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
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

/**
 * Canonical UUID (v1–v5) matcher. A projectId is used as an on-disk path
 * segment, so it MUST match this before being trusted. Mirrors the controller's
 * ParseUUIDPipe — defense in depth so the storage layer is safe even if called
 * directly (e.g. by a future caller that skips the HTTP pipe).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  /**
   * Best-effort deletion of a previously saved blob (used to clean up an orphan
   * blob when the db row insert fails after the blob was already written).
   */
  deletePath(storagePath: string): Promise<void>;
}

class FilesystemBlobStore implements BlobStore {
  constructor(readonly baseDir: string) {}

  async save(
    projectId: string,
    originalName: string,
    data: Buffer,
  ): Promise<string> {
    // SECURITY: projectId is used as a path segment. Assert it is a UUID before
    // it is ever joined into a path — a hostile value like `../../../tmp/evil`
    // must never reach resolve().
    if (!UUID_RE.test(projectId)) {
      throw new Error('invalid projectId (must be a UUID)');
    }

    // The TRUSTED fixed root. The per-project dir is derived from the (now
    // validated) projectId, but we assert containment against THIS root, which
    // contains no untrusted input, so the guard cannot be fooled by an escaped
    // projectId.
    const filesRoot = resolve(this.baseDir, 'files');
    const projectDir = resolve(filesRoot, projectId);
    const safeName = `${randomUUID()}-${sanitizeFilename(originalName)}`;
    const target = resolve(projectDir, safeName);

    // Defense in depth: the resolved target MUST stay within the trusted
    // filesRoot. Computed against filesRoot (NOT projectDir) so an escaped
    // projectId cannot slip past a guard derived from itself.
    if (!target.startsWith(filesRoot + sep)) {
      throw new Error('resolved storage path escapes files root');
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

  async deletePath(storagePath: string): Promise<void> {
    await unlink(storagePath);
  }
}

/** Builds a filesystem blob store rooted at DATA_DIR (env, default `./data`). */
export function createStorage(baseDir: string = resolveDataDir()): BlobStore {
  return new FilesystemBlobStore(baseDir);
}
