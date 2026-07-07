// Route address helpers — convert between Angular route segments and MapleAddress.
//
// Used by BrowseShellComponent and EditorShellComponent to read the current
// address from ActivatedRoute.snapshot.url and build Router.navigate() targets.
//
// Route format:
//   /browse/:slug/**  → BrowseShellComponent
//   /edit/:slug/**    → EditorShellComponent
//
// Angular's router passes the ** wildcard as remaining url.segments[N].path
// values, ALREADY percent-decoded. We join them as-is into relPath.

import { parseAddress } from './maple-address';
import type { MapleAddress } from './maple-address';

/**
 * Convert a slug + array of remaining URL segments into a MapleAddress.
 *
 * Angular's Router already percent-decodes `UrlSegment.path`, so we must NOT
 * decode again — double-decoding corrupts filenames containing a literal `%xx`
 * sequence (e.g. an already-decoded "a%20b" would wrongly become "a b").
 *
 * @param slug - the `:slug` route param
 * @param segments - the ** wildcard segments (empty at library root)
 */
export function routeSegmentsToAddress(slug: string, segments: string[]): MapleAddress {
  return { slug, relPath: segments.join('/') };
}

/**
 * Convert a MapleAddress into Router.navigate() segments for browsing, editing, or viewing.
 *
 * @param a - the address to navigate to
 * @param mode - 'browse' (default), 'edit', or 'view'
 */
export function addressToRouteSegments(
  a: MapleAddress,
  mode: 'browse' | 'edit' | 'view' = 'browse',
): string[] {
  const base = `/${mode}`;
  const relParts = a.relPath ? a.relPath.split('/') : [];
  return [base, a.slug, ...relParts];
}

/**
 * Router.navigate() commands to open an asset id in the editor.
 *
 * The `/edit/:slug/**` route expects the slug and the relPath as SEPARATE
 * segments. A MapleAddress id is a single `slug:relPath` string, so passing
 * `['/edit', id]` puts the WHOLE id into `:slug` (relPath empty) — the editor
 * then resolves a bogus address, finds no asset, and bounces back to Browse.
 * Split the address into its segments instead.
 *
 * Legacy `fs:<absPath>` ids (Self-Hosted search results, cold-load) and any id
 * without a colon are NOT MapleAddresses — pass them through as a single segment.
 * `EditorShellComponent` detects an `fs:` `:slug` and hydrates it via the
 * FS-walk cold-load path.
 */
export function editRouteCommands(id: string): string[] {
  // `fs:` ids contain ':' but aren't addresses; ids without ':' aren't either.
  if (id.startsWith('fs:') || !id.includes(':')) {
    return ['/edit', id];
  }
  const addr = parseAddress(id);
  // A malformed id like ':foo' parses to an empty slug — pass it through rather
  // than emit an empty `/edit//foo` route segment. (parseAddress never throws.)
  if (!addr.slug) return ['/edit', id];
  return addressToRouteSegments(addr, 'edit');
}

/**
 * Router.navigate() commands to open an asset id in the fast Preview surface.
 *
 * Mirrors editRouteCommands() exactly, but routes to `/view/:slug/**` instead.
 * The `/view/:slug/**` route expects the slug and the relPath as SEPARATE
 * segments. A MapleAddress id is a single `slug:relPath` string, so passing
 * `['/view', id]` puts the WHOLE id into `:slug` (relPath empty) — the preview
 * then resolves a bogus address, finds no asset, and bounces back to Browse.
 * Split the address into its segments instead.
 *
 * Legacy `fs:<absPath>` ids (Self-Hosted search results, cold-load) and any id
 * without a colon are NOT MapleAddresses — pass them through as a single segment.
 * `PreviewShellComponent` detects an `fs:` `:slug` and hydrates it via the
 * FS-walk cold-load path.
 */
export function viewRouteCommands(id: string): string[] {
  // `fs:` ids contain ':' but aren't addresses; ids without ':' aren't either.
  if (id.startsWith('fs:') || !id.includes(':')) {
    return ['/view', id];
  }
  const addr = parseAddress(id);
  // A malformed id like ':foo' parses to an empty slug — pass it through rather
  // than emit an empty `/view//foo` route segment. (parseAddress never throws.)
  if (!addr.slug) return ['/view', id];
  return addressToRouteSegments(addr, 'view');
}
