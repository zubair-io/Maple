/**
 * Unified address resolver for the slug:relPath addressing scheme.
 *
 * `parseAddressPath` — splits the Elysia wildcard segments into
 *   (slug, relPath) so route handlers can call resolveAddress.
 *
 * `resolveAddress` — the single server-side jail: slug → libraryRoot via the
 *   in-memory libraries cache (zero DB per lookup), then relPath is validated
 *   and joined under the root. A realpath check ensures symlinks cannot escape
 *   the jail. All four M1 routes (`/api/folder|image|thumb|preview`) call
 *   this; the old per-route jails remain for backward-compat legacy routes.
 */

import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ObjectId } from 'mongodb';
import { getLibraryBySlug } from '../indexer/libraries.cache.ts';
import { isUnderRoot } from '../fs/browse.ts';

export interface AddressPath {
  slug: string;
  relPath: string;
}

export interface ResolvedAddress {
  libraryId: ObjectId;
  libraryRoot: string;
  absPath: string;
}

/**
 * Parse the wildcard segments from an Elysia `/:slug/*` route into the
 * address components. The slug is the first path segment; the remaining
 * segments (already percent-decoded by Elysia) are joined with `/`.
 */
export function parseAddressPath(slug: string, restSegments: string[]): AddressPath {
  const relPath = restSegments.join('/');
  return { slug, relPath };
}

/**
 * Resolve a (slug, relPath) pair to an on-disk absolute path inside the
 * library jail.
 *
 * Throws an object with `{ status: 400 }` on traversal / escape attempts.
 * Throws an object with `{ status: 404 }` for unknown slugs.
 *
 * Security model (consolidating the strongest parts of the five existing jails):
 *   1. slug → libraryRoot via the in-memory cache (no DB).
 *   2. Reject absolute relPath, any `..` or `.` segment, or backslash.
 *   3. realpath(absPath) must be under realpath(libraryRoot) — symlink-safe.
 */
export async function resolveAddress(slug: string, relPath: string): Promise<ResolvedAddress> {
  // 1. Slug lookup.
  const lib = await getLibraryBySlug(slug);
  if (!lib) {
    throw { status: 404, message: `Unknown library slug: ${slug}` };
  }
  const { libraryId, root } = lib;

  // 2. Validate relPath.
  if (relPath !== '') {
    if (path.isAbsolute(relPath)) {
      throw { status: 400, message: 'relPath must not be absolute' };
    }
    if (relPath.includes('\\')) {
      throw { status: 400, message: 'relPath must not contain backslashes' };
    }
    const segments = relPath.split('/');
    for (const seg of segments) {
      if (seg === '..' || seg === '.') {
        throw { status: 400, message: `relPath must not contain '.' or '..' segments` };
      }
    }
  }

  // 3. Compute absPath and realpath-jail check.
  const absPath = relPath === '' ? root : path.join(root, relPath);

  // Resolve symlinks: realpath the nearest existing ancestor if the target
  // doesn't exist yet (e.g. an indexed path not yet on disk).
  let realAbs: string;
  try {
    realAbs = await realpath(absPath);
  } catch {
    // Target doesn't exist — realpath the parent to still catch escapes.
    const parent = path.dirname(absPath);
    try {
      const realParent = await realpath(parent);
      realAbs = path.join(realParent, path.basename(absPath));
    } catch {
      // Parent also doesn't exist — fall back to the unresolved path.
      // The jail check below will still validate against the root.
      realAbs = absPath;
    }
  }

  const realRoot = await realpath(root);
  if (!isUnderRoot(realAbs, realRoot)) {
    throw { status: 400, message: 'Path escapes library jail' };
  }

  return { libraryId, libraryRoot: root, absPath };
}
