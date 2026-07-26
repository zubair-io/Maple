// xmp-canonical.ts — the canonical sidecar document shape (#1577).
//
// `docs/xmp-canonical-format.md` is the prose contract; this module is its
// TypeScript implementation, and `XMPSerialization+Canonical.swift` is the
// Swift one. The two are written to emit the same bytes for the same
// attribute list, which is what the cross-engine zero-diff test pins.
//
// Namespace URI note (#1577): the `papp:` prefix — not the URI it is bound
// to — is the discriminator every Maple parser keys on. raw-core's
// `xmp::parse` matches attribute names byte-wise (`papp:Profile`), the Swift
// `XMLParser` runs with namespace processing OFF so `attributeDict` is keyed
// on qualified names, and the TypeScript parser compares `attr.name`, which
// is also the qualified name. None of the three ever resolves a namespace
// URI. The canonical URI below is therefore free to be chosen for tidiness
// rather than compatibility, and existing sidecars written against the older
// Swift URI keep parsing unchanged.

/** Canonical `papp:` namespace URI — see the note above. */
export const PAPP_NAMESPACE_URI = 'http://ns.justmaple.app/photo/1.0/';

/**
 * Namespace declarations emitted on every `rdf:Description`, in this exact
 * order, whether or not the payload uses them. They are structural: a fixed
 * prelude keeps the head of every sidecar byte-stable.
 */
const CORE_NAMESPACES: ReadonlyArray<readonly [string, string]> = [
  ['xmp', 'http://ns.adobe.com/xap/1.0/'],
  ['crs', 'http://ns.adobe.com/camera-raw-settings/1.0/'],
  ['papp', PAPP_NAMESPACE_URI],
];

/**
 * Sort rank per namespace prefix. Ranks the three core namespaces first (the
 * develop settings a reader cares about), then the metadata namespaces in the
 * order they are declared, then everything else — unknown passthrough
 * attributes, which sort last so an imported sidecar's foreign attributes stay
 * out of the middle of Maple's own block.
 */
const NAMESPACE_PRIORITY: Readonly<Record<string, number>> = {
  xmp: 0,
  crs: 1,
  papp: 2,
  dc: 3,
  exif: 4,
  photoshop: 5,
  Iptc4xmpCore: 6,
  xmpRights: 7,
};

const UNKNOWN_NAMESPACE_PRIORITY = 500;

/** Indent of `rdf:Description`'s attributes, namespace declarations and children. */
export const DESCRIPTION_CHILD_INDENT = '      ';

/**
 * Rank for a rendered `prefix:Name="value"` attribute. An attribute with no
 * prefix (there are none today outside passthrough) ranks as unknown.
 */
function attributePriority(name: string): number {
  const colon = name.indexOf(':');
  if (colon < 0) return UNKNOWN_NAMESPACE_PRIORITY;
  return NAMESPACE_PRIORITY[name.slice(0, colon)] ?? UNKNOWN_NAMESPACE_PRIORITY;
}

/** The attribute name of a rendered `name="value"` part. */
const attributeName = (part: string): string => part.slice(0, part.indexOf('='));

/**
 * Order rendered `name="value"` attribute parts canonically: namespace
 * priority first, then alphabetically by fully-qualified name within each
 * namespace.
 *
 * Attribute names are XML NCNames drawn from the schema plus whatever a
 * foreign sidecar carried, so the alphabetical tiebreak is a plain string
 * comparison; every name Maple or Adobe writes is ASCII, where JavaScript's
 * code-unit ordering and Swift's ordering agree.
 */
export function sortCanonicalAttributes(parts: readonly string[]): string[] {
  return [...parts].sort((a, b) => {
    const byNamespace = attributePriority(attributeName(a)) - attributePriority(attributeName(b));
    if (byNamespace !== 0) return byNamespace;
    const nameA = attributeName(a);
    const nameB = attributeName(b);
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });
}

/**
 * Assemble the canonical sidecar document.
 *
 * `extraNamespaces` are the conditional declarations (metadata prefixes,
 * `dc` for the keyword bag) appended after the three core ones in the caller's
 * fixed order. `attributes` are rendered `name="value"` parts, sorted here so
 * no caller can forget. `children` is the already-indented nested-element
 * body, or the empty string for the self-closing form.
 */
export function canonicalDocument(
  extraNamespaces: ReadonlyArray<readonly [string, string]>,
  attributes: readonly string[],
  children: string,
): string {
  const indent = DESCRIPTION_CHILD_INDENT;
  const nsLines = [...CORE_NAMESPACES, ...extraNamespaces].map(
    ([prefix, uri]) => `${indent}xmlns:${prefix}="${uri}"`,
  );
  const attrLines = sortCanonicalAttributes(attributes).map((part) => `${indent}${part}`);
  const head = [...nsLines, ...attrLines].join('\n');
  const body = children.length === 0 ? '/>' : `>\n${children}\n    </rdf:Description>`;

  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '    <rdf:Description rdf:about=""',
    `${head}${body}`,
    '  </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}
