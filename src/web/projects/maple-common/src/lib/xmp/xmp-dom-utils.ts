// xmp-dom-utils.ts — tiny shared DOM-attribute helper for the XMP parser
// split (#2215). `xmp-culling.ts` and `xmp-metadata.ts`'s parse half both
// need "try multiple attribute name variants (namespaced vs unprefixed)";
// a single shared home avoids the copy-paste fallow's duplicate-code
// detector flags when each file declares it locally.

export const RDF_NAMESPACE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const XMP_NAMESPACE = 'http://ns.adobe.com/xap/1.0/';
export const CRS_NAMESPACE = 'http://ns.adobe.com/camera-raw-settings/1.0/';
export const PAPP_NAMESPACES = [
  'http://ns.justmaple.app/photo/1.0/',
  'http://ns.justmaple.app/1.0/',
] as const;

const NAMESPACES: Readonly<Record<string, readonly string[]>> = {
  rdf: [RDF_NAMESPACE],
  xmp: [XMP_NAMESPACE],
  crs: [CRS_NAMESPACE],
  papp: PAPP_NAMESPACES,
  maple: ['https://maple.app/ns/1.0/'],
  dc: ['http://purl.org/dc/elements/1.1/'],
  exif: ['http://ns.adobe.com/exif/1.0/'],
  photoshop: ['http://ns.adobe.com/photoshop/1.0/'],
  Iptc4xmpCore: ['http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/'],
  xmpRights: ['http://ns.adobe.com/xap/1.0/rights/'],
};

/** Canonical qualified name for a recognized XMP node, independent of its source prefix. */
export function managedXmpName(node: Attr | Element): string | null {
  if (!node.namespaceURI) return node.prefix ? null : node.localName;
  for (const [prefix, uris] of Object.entries(NAMESPACES)) {
    if (uris.includes(node.namespaceURI)) return `${prefix}:${node.localName}`;
  }
  return null;
}

/** Find RDF descriptions by namespace identity, never by a spoofable prefix. */
export function rdfDescriptions(document: Document): Element[] {
  return Array.from(document.getElementsByTagNameNS(RDF_NAMESPACE, 'Description')).filter(
    (description) =>
      description.parentElement?.namespaceURI === RDF_NAMESPACE &&
      description.parentElement.localName === 'RDF',
  );
}

/** Prefer the description carrying modeled XMP data, regardless of RDF sibling order. */
export function primaryXmpDescription(document: Document): Element | null {
  const descriptions = rdfDescriptions(document);
  const score = (description: Element): number =>
    [...description.attributes, ...description.children].filter((node) => {
      const name = managedXmpName(node);
      return name !== null && name !== 'rdf:about';
    }).length;
  return descriptions.reduce<Element | null>(
    (best, candidate) => (!best || score(candidate) > score(best) ? candidate : best),
    null,
  );
}

const directDescriptionSiblings = (description: Element): Element[] =>
  Array.from(description.parentElement?.children ?? []).filter(
    (element) => element.namespaceURI === RDF_NAMESPACE && element.localName === 'Description',
  );

/**
 * Merge modeled XMP nodes across direct RDF description siblings. The first
 * occurrence of each expanded name wins, making duplicate-field precedence
 * deterministic while allowing disjoint fields to live in separate blocks.
 */
export function mergedXmpDescription(document: Document): Element | null {
  const primary = primaryXmpDescription(document);
  if (!primary) return null;
  const merged = document.createElementNS(RDF_NAMESPACE, 'rdf:Description');
  const names = new Set<string>();
  for (const description of directDescriptionSiblings(primary)) {
    for (const node of [...description.attributes, ...description.children]) {
      const name = managedXmpName(node);
      if (!name || name === 'rdf:about' || names.has(name)) continue;
      names.add(name);
      if (node instanceof Attr) {
        merged.setAttributeNS(node.namespaceURI, node.name, node.value);
      } else {
        merged.append(node.cloneNode(true));
      }
    }
  }
  return merged;
}

/** Try canonical namespaced and legacy unprefixed attribute variants. */
export function attrOf(desc: Element, names: readonly string[]): string | null {
  for (const name of names) {
    const colon = name.indexOf(':');
    if (colon > 0) {
      const prefix = name.slice(0, colon);
      const localName = name.slice(colon + 1);
      for (const namespace of NAMESPACES[prefix] ?? []) {
        const value = desc.getAttributeNS(namespace, localName);
        if (value !== null) return value;
      }
      continue;
    }
    const val = desc.getAttribute(name);
    if (val !== null) return val;
  }
  return null;
}
