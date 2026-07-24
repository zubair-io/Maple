// xmp-dom-utils.ts — tiny shared DOM-attribute helper for the XMP parser
// split (#2215). `xmp-culling.ts` and `xmp-metadata.ts`'s parse half both
// need "try multiple attribute name variants (namespaced vs unprefixed)";
// a single shared home avoids the copy-paste fallow's duplicate-code
// detector flags when each file declares it locally.

/**
 * Try multiple attribute name variants (namespaced vs unprefixed).
 * DOMParser may or may not preserve namespace prefixes.
 */
export function attrOf(desc: Element, names: string[]): string | null {
  for (const name of names) {
    const val = desc.getAttribute(name);
    if (val !== null) return val;
  }
  return null;
}
