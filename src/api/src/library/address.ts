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
 * Parse an address string of the form `"slug:relPath"` into its components.
 *
 * Throws `{ status: 400 }` when the string is malformed (no colon, or empty slug).
 */
export function parseAddressString(addr: string): AddressPath {
  const i = addr.indexOf(':');
  if (i === -1 || i === 0) {
    throw Object.assign(new Error('malformed address'), { status: 400 });
  }
  return { slug: addr.slice(0, i), relPath: addr.slice(i + 1) };
}

/**
 * Resolve an address string of the form `"slug:relPath"` to an on-disk absolute
 * path inside the library jail. Convenience wrapper around parseAddressString +
 * resolveAddress. Always returns a Promise (parse errors become rejections).
 */
export async function resolveAddressString(addr: string): Promise<ResolvedAddress> {
  const { slug, relPath } = parseAddressString(addr);
  return resolveAddress(slug, relPath);
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
    throw Object.assign(new Error(`Unknown library slug: ${slug}`), { status: 404 });
  }
  const { libraryId, root } = lib;

  // 2. Validate relPath.
  if (relPath !== '') {
    if (path.isAbsolute(relPath)) {
      throw Object.assign(new Error('relPath must not be absolute'), { status: 400 });
    }
    if (relPath.includes('\\')) {
      throw Object.assign(new Error('relPath must not contain backslashes'), { status: 400 });
    }
    const segments = relPath.split('/');
    for (const seg of segments) {
      if (seg === '..' || seg === '.') {
        throw Object.assign(new Error(`relPath must not contain '.' or '..' segments`), {
          status: 400,
        });
      }
    }
  }

  // 3. Compute absPath and realpath-jail check.
  const absPath = relPath === '' ? root : path.join(root, relPath);

  // Resolve symlinks. If the target doesn't exist yet, walk up to the nearest
  // EXISTING ancestor and realpath that — so an escaping symlink anywhere in
  // the existing portion is resolved and caught — then re-append the
  // non-existent tail. The tail is guaranteed free of `.`/`..` by the
  // validation above, so it cannot escape textually. (A single-level parent
  // realpath would miss an escaping symlink higher up under a non-existent
  // tail.)
  let realAbs: string;
  try {
    realAbs = await realpath(absPath);
  } catch {
    const tail: string[] = [];
    let cursor = absPath;
    for (;;) {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        // Reached the filesystem root without an existing ancestor.
        realAbs = absPath;
        break;
      }
      tail.unshift(path.basename(cursor));
      try {
        const realParent = await realpath(parent);
        realAbs = path.join(realParent, ...tail);
        break;
      } catch {
        cursor = parent;
      }
    }
  }

  const realRoot = await realpath(root);
  if (!isUnderRoot(realAbs, realRoot)) {
    throw Object.assign(new Error('Path escapes library jail'), { status: 400 });
  }

  return { libraryId, libraryRoot: root, absPath };
}
