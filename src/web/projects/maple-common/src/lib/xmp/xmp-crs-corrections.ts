// xmp-crs-corrections.ts — the scaffolding every Adobe `crs:` correction
// container is built from, shared by `xmp-local-adjustments.ts` (#358) and
// `xmp-retouch.ts` (#3409).
//
// Both containers have the same shape — `<container><rdf:Seq><rdf:li>
// <rdf:Description …><crs:SomeMasks><rdf:Seq><rdf:li …/>` — and both read
// their attributes with the same "a finite number, or absent" rule. Only the
// leaf semantics differ (a mask layer and a repair spot are different
// shapes), so those stay in their own files; this is the walk and the
// attribute codecs they agree on.
//
// RDF structural elements are matched on LOCAL NAME only, like raw-core's
// `is_seq` / `is_li` / `is_description`: a sidecar may bind RDF to any
// prefix and still be valid.

import { attrOf } from './xmp-dom-utils';

/** Direct children of `el` whose local name is `local`. */
export const childrenNamed = (el: Element, local: string): Element[] =>
  Array.from(el.children).filter((c) => c.localName === local);

/** A finite numeric attribute, or undefined when absent, blank or unparseable. */
export const finiteAttr = (el: Element, name: string): number | undefined => {
  const raw = attrOf(el, [name]);
  if (raw === null || raw.trim().length === 0) return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
};

/** Adobe's boolean spellings, case-insensitive; undefined for anything else. */
export const xmpBool = (raw: string | null): boolean | undefined => {
  const lower = raw?.trim().toLowerCase();
  if (lower === '1' || lower === 'true' || lower === 'on') return true;
  if (lower === '0' || lower === 'false' || lower === 'off') return false;
  return undefined;
};

/**
 * Every correction `rdf:Description` inside a container element — the
 * `rdf:Seq` → `rdf:li` → `rdf:Description` walk both containers share.
 */
export const correctionDescriptions = (container: Element): Element[] =>
  childrenNamed(container, 'Seq')
    .flatMap((seq) => childrenNamed(seq, 'li'))
    .flatMap((li) => childrenNamed(li, 'Description'));

/**
 * Every mask leaf under a correction's nested masks element
 * (`crs:CorrectionMasks` for a local adjustment, `crs:Masks` for a repair
 * spot) — the same `rdf:Seq` → `rdf:li` walk one level deeper.
 */
export const maskLeaves = (description: Element, masksLocalName: string): Element[] =>
  childrenNamed(description, masksLocalName)
    .flatMap((masks) => childrenNamed(masks, 'Seq'))
    .flatMap((seq) => childrenNamed(seq, 'li'));

/**
 * The first leaf `read` recognises, or undefined when none is a shape this
 * build models. Tolerates a correction carrying more than one leaf — e.g. a
 * future intersection of masks alongside one Maple understands.
 */
export function firstRecognisedLeaf<T>(
  leaves: readonly Element[],
  read: (leaf: Element) => T | undefined,
): T | undefined {
  for (const leaf of leaves) {
    const parsed = read(leaf);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}
