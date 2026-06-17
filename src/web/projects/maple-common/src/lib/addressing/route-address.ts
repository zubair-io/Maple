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
 * Convert a MapleAddress into Router.navigate() segments for browsing or editing.
 *
 * @param a - the address to navigate to
 * @param mode - 'browse' (default) or 'edit'
 */
export function addressToRouteSegments(
  a: MapleAddress,
  mode: 'browse' | 'edit' = 'browse',
): string[] {
  const base = `/${mode}`;
  const relParts = a.relPath ? a.relPath.split('/') : [];
  return [base, a.slug, ...relParts];
}
