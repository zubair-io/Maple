/**
 * Filesystem path restriction — chroot-like safety layer.
 *
 * The server only reads/writes under the registered folder roots.
 * Any attempt to escape via ".." or symlinks outside the root is rejected.
 *
 * Additionally, if MAPLE_ROOTS env is set (colon-separated absolute paths),
 * all file access is restricted to those roots. If unset, the restriction is
 * per-folder (registered roots from the DB are the boundary).
 */

import { stat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';

export interface OpResult<T = undefined> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Registered roots — updated at startup from DB and on folder registration.
 * Using a simple Set for O(1) prefix checks.
 */
const _registeredRoots = new Set<string>();
let envRootsCache:
  | {
      value: string | undefined;
      roots: Promise<string[]>;
    }
  | undefined;

async function normalizedEnvRoots(): Promise<string[]> {
  const value = process.env.MAPLE_ROOTS;
  if (envRootsCache && envRootsCache.value === value) return envRootsCache.roots;
  const roots = Promise.all(
    (value ?? '')
      .split(':')
      .filter(Boolean)
      .map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return path.resolve(root);
        }
      }),
  );
  // Publish the value and its in-flight normalization atomically. Concurrent
  // authorization checks must await the same promise; exposing an interim
  // empty array would turn a configured-root policy into allow-all.
  envRootsCache = { value, roots };
  return roots;
}

/** Register a root so that file access under it is permitted.
 *  Resolves symlinks so that macOS /var → /private/var is handled correctly. */
export function registerRoot(absPath: string): void {
  const normalized = absPath.replace(/\/$/, '');
  // Eagerly resolve the real path synchronously; fall back to as-given.
  let real = normalized;
  try {
    real = require('fs').realpathSync(normalized);
  } catch {}
  _registeredRoots.add(real);
  // Also add the original (pre-symlink) path in case realpath fails later.
  if (real !== normalized) _registeredRoots.add(normalized);
}

/** Unregister a root. */
export function unregisterRoot(absPath: string): void {
  const normalized = absPath.replace(/\/$/, '');
  _registeredRoots.delete(normalized);
  try {
    _registeredRoots.delete(require('fs').realpathSync(normalized));
  } catch {}
}

/** Return a snapshot of registered roots. */
export function getRegisteredRoots(): string[] {
  return [..._registeredRoots];
}

/**
 * Check whether `filePath` is under one of the registered roots (or any
 * MAPLE_ROOTS env entries). Returns the real (resolved) path on success.
 */
async function checkAllowed(filePath: string): Promise<OpResult<string>> {
  let real: string;
  try {
    // Resolve symlinks to prevent directory traversal.
    real = await realpath(filePath);
  } catch {
    // File might not exist yet (e.g., XMP to be written).
    // Use path.resolve on the raw path.
    real = path.resolve(filePath);
  }

  // Env-level roots take precedence.
  const envRoots = await normalizedEnvRoots();
  const allowedRoots = [...envRoots, ..._registeredRoots];

  if (allowedRoots.length === 0) {
    // No roots configured — allow all (development convenience).
    return { ok: true, data: real };
  }

  for (const root of allowedRoots) {
    const normalRoot = root.replace(/\/$/, '');
    if (real === normalRoot || real.startsWith(normalRoot + '/')) {
      return { ok: true, data: real };
    }
  }

  return {
    ok: false,
    error:
      `Path "${real}" is outside all registered roots. ` +
      `Registered: [${allowedRoots.join(', ')}]`,
  };
}

/**
 * Validate that a prospective root directory:
 *   1. Is an absolute path.
 *   2. Exists and is a directory.
 *   3. Is readable.
 */
export async function validateRoot(dirPath: string): Promise<OpResult> {
  if (!path.isAbsolute(dirPath)) {
    return { ok: false, error: 'Path must be absolute.' };
  }
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) {
      return { ok: false, error: `"${dirPath}" is not a directory.` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Cannot access "${dirPath}": ${msg}` };
  }
}

/**
 * Safe file read: checks allowed roots then streams the content.
 */
export async function safeReadFile(filePath: string): Promise<OpResult<Buffer>> {
  const check = await checkAllowed(filePath);
  if (!check.ok) return { ok: false, error: check.error };

  try {
    const data = await readFile(check.data!);
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Cannot read "${filePath}": ${msg}` };
  }
}

/**
 * Safe file write: checks allowed roots first.
 * Returns the resolved absolute path on success.
 */
export async function safeWriteAllowed(filePath: string): Promise<OpResult<string>> {
  // For writes, the file may not exist yet; check parent dir.
  const parent = path.dirname(filePath);
  const check = await checkAllowed(parent);
  if (!check.ok) {
    // Also try the file path itself (in case dirname escapes).
    const check2 = await checkAllowed(filePath);
    if (!check2.ok) return { ok: false, error: check.error };
  }
  return { ok: true, data: path.resolve(filePath) };
}
