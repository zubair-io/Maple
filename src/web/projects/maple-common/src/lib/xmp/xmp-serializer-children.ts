// xmp-serializer-children.ts — nested-child and namespace composition split
// out of `XmpSerializerService.serialize` (#1840, complexity hotspot).

import type { PassthroughBucket, XmpMetadata } from './xmp.types';
import {
  metadataNamespacePrefixes,
  metadataNestedBlocks,
  METADATA_NAMESPACES,
} from './xmp-metadata';
import { escapeXmpText } from './xmp-serializer-parts';

/**
 * `dc:subject` — IPTC keyword bag (#632), as a nested
 * `<dc:subject><rdf:Bag><rdf:li>…</rdf:Bag></dc:subject>` block. An empty /
 * undefined list omits the element entirely so the round-trip empty → no
 * element → empty matches the read path's "no element" default and matches
 * Apple's `XMPSerializer` behaviour. Returns the filtered keyword list too,
 * since the caller needs it to decide whether `dc` joins the namespace list.
 */
export function buildKeywordsBlock(
  keywords: readonly string[] | undefined,
  indent: string,
): { block: string; filtered: string[] } {
  const filtered = (keywords ?? []).filter((k) => k && k.trim().length > 0);
  if (filtered.length === 0) return { block: '', filtered };
  const block = [
    `${indent}<dc:subject>`,
    `${indent}  <rdf:Bag>`,
    ...filtered.map((k) => `${indent}    <rdf:li>${escapeXmpText(k)}</rdf:li>`),
    `${indent}  </rdf:Bag>`,
    `${indent}</dc:subject>`,
  ].join('\n');
  return { block, filtered };
}

/**
 * Composes the nested children in their canonical slots: metadata
 * title/creator/description first, then keywords (`dc:subject`), then
 * metadata rights/usageTerms, then any authored tone-curve blocks, then the
 * local-adjustment containers (#358), then any unknown passthrough nodes. Takes the raw optional `metadata`/`passthrough`
 * rather than pre-resolved arrays so the caller (`XmpSerializerService.serialize`)
 * doesn't have to branch on them itself.
 */
export function composeNestedChildren(params: {
  metadata: XmpMetadata | undefined;
  passthrough: PassthroughBucket | undefined;
  keywordsBlock: string;
  toneCurvesBlock: string;
  localAdjustmentsBlock: string;
  indent: string;
}): string {
  const metadataBlocks = params.metadata ? metadataNestedBlocks(params.metadata) : [];
  const titleCreatorDesc = metadataBlocks.filter((b) =>
    /^ *<(dc:title|dc:creator|dc:description)>/.test(b),
  );
  const rightsUsage = metadataBlocks.filter((b) => /^ *<(dc:rights|xmpRights:UsageTerms)>/.test(b));
  const nestedNodes = (params.passthrough?.unknownNodes ?? [])
    .map((n) => `${params.indent}${n}`)
    .join('\n');
  return [
    titleCreatorDesc.join('\n'),
    params.keywordsBlock,
    rightsUsage.join('\n'),
    params.toneCurvesBlock,
    params.localAdjustmentsBlock,
    nestedNodes,
  ]
    .filter((b) => b.length > 0)
    .join('\n');
}

const NAMESPACE_ORDER = ['dc', 'exif', 'photoshop', 'Iptc4xmpCore', 'xmpRights'];

/**
 * Namespace declarations beyond the always-present xmp/crs/papp prelude
 * (emitted by `canonicalDocument`): the conditional metadata namespaces plus
 * `dc` when keywords are present, in fixed prefix order, followed by any
 * passthrough namespaces sorted by prefix.
 */
export function resolveExtraNamespaces(params: {
  metadata: XmpMetadata | undefined;
  hasKeywords: boolean;
  unknownNamespaces: ReadonlyArray<{ prefix: string; uri: string }> | undefined;
}): Array<readonly [string, string]> {
  const usedPrefixes = params.metadata
    ? metadataNamespacePrefixes(params.metadata)
    : new Set<string>();
  if (params.hasKeywords) usedPrefixes.add('dc');
  const extraNamespaces: Array<readonly [string, string]> = NAMESPACE_ORDER.filter((p) =>
    usedPrefixes.has(p),
  ).map((p) => [p, METADATA_NAMESPACES[p]] as const);
  for (const namespace of [...(params.unknownNamespaces ?? [])].sort((a, b) =>
    a.prefix.localeCompare(b.prefix),
  )) {
    extraNamespaces.push([namespace.prefix, namespace.uri]);
  }
  return extraNamespaces;
}
