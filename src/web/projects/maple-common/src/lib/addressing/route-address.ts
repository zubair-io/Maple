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
// values. We join them (decoding percent-encoding if present) into relPath.

import type { MapleAddress } from './maple-address';

/**
 * Convert a slug + array of remaining URL segments into a MapleAddress.
 * Each segment is decoded from percent-encoding if needed.
 *
 * @param slug - the `:slug` route param
 * @param segments - the ** wildcard segments (empty at library root)
 */
export function routeSegmentsToAddress(slug: string, segments: string[]): MapleAddress {
  const parts = segments.map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
  return { slug, relPath: parts.join('/') };
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
