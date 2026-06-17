// MapleAddress — stable address grammar for library items.
//
// Grammar: `slug:relPath` where slug = [a-z0-9-]+ and relPath is POSIX.
// The first colon separates slug from relPath; subsequent colons are part
// of relPath. Empty relPath represents the library root.
//
// This is the single-source-of-truth replacing 14+ inline `fs:${path}`
// construction and stripping sites across the codebase.

export interface MapleAddress {
  readonly slug: string;
  readonly relPath: string;
}

/**
 * Parse `slug:relPath` into a `MapleAddress`. Splits on the FIRST colon only,
 * so filenames containing colons are preserved verbatim in `relPath`.
 */
export function parseAddress(s: string): MapleAddress {
  const idx = s.indexOf(':');
  if (idx < 0) {
    // No colon — treat entire string as slug with empty relPath.
    return { slug: s, relPath: '' };
  }
  return { slug: s.slice(0, idx), relPath: s.slice(idx + 1) };
}

/**
 * Serialize a `MapleAddress` back to `slug:relPath`. Empty relPath → `slug:`.
 */
export function formatAddress(a: MapleAddress): string {
  return `${a.slug}:${a.relPath}`;
}

/**
 * Return the address of a child item within a directory address.
 * `childAddress({ slug: 'l', relPath: '2026' }, 'France')` → `{ slug: 'l', relPath: '2026/France' }`
 */
export function childAddress(dir: MapleAddress, name: string): MapleAddress {
  return {
    slug: dir.slug,
    relPath: dir.relPath === '' ? name : `${dir.relPath}/${name}`,
  };
}

/**
 * Return the parent directory address, or `null` if already at the library root.
 */
export function parentAddress(a: MapleAddress): MapleAddress | null {
  if (a.relPath === '') return null;
  const lastSlash = a.relPath.lastIndexOf('/');
  return {
    slug: a.slug,
    relPath: lastSlash < 0 ? '' : a.relPath.slice(0, lastSlash),
  };
}

/**
 * Build the API path component for this address. Each segment (slug + each
 * relPath component) is individually percent-encoded with `encodeURIComponent`.
 *
 * `toApiPath({ slug: 'library', relPath: '2026/My Photo #3.JPG' })`
 * → `'library/2026/My%20Photo%20%233.JPG'`
 *
 * Empty relPath → just the slug (no trailing slash).
 */
export function toApiPath(a: MapleAddress): string {
  // Encode the slug too — `parseAddress`/`routeSegmentsToAddress` accept any
  // string, so an un-encoded slug from a crafted deep link (e.g. "../../admin")
  // would otherwise inject path-traversal sequences into the API URL. For a
  // valid minted slug ([a-z0-9-]) this is a no-op.
  const segments: string[] = [encodeURIComponent(a.slug)];
  if (a.relPath !== '') {
    for (const seg of a.relPath.split('/')) {
      segments.push(encodeURIComponent(seg));
    }
  }
  return segments.join('/');
}
