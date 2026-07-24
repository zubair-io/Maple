// xmp-culling.ts — culling (rating / flag / colorLabel) + IPTC `dc:subject`
// keyword-bag parser (#632). Split out of `XmpParserService.parseCulling`
// (#2215, file-size budget) — this half is pure (element in, `XmpCulling`
// out) so it's independently testable and round-trips without the DOM
// parse/error-handling wrapper that stays in the service. Broken into two
// single-purpose sub-parsers (rating/flag/label vs. the keyword bag) rather
// than one large function, matching the fallow complexity/unit-size gate's
// per-function thresholds.

import type { XmpCulling, XmpFlag, XmpColorLabel } from './xmp.types';
import { isColorLabelValue } from '../models/color-label';
import { attrOf } from './xmp-dom-utils';

/**
 * Dublin Core namespace URI — owns `dc:subject` (the IPTC keyword bag).
 * Exported because `XmpParserService.parseAdjustmentModel`'s passthrough
 * exclusion (`dc:subject` must never double-emit) also needs it.
 */
export const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
/** RDF namespace URI — owns `rdf:Bag` and `rdf:li`. */
const RDF_NAMESPACE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** XMP xmp:Label words → Maple colorLabel values. `Purple` (#1657) is the
 * word Adobe tools (Lightroom/Bridge) write for their fifth default label
 * color — it was missing here, so a Lightroom-authored `xmp:Label="Purple"`
 * silently failed to parse into any colorLabel at all. */
const LABEL_MAP: Record<string, XmpColorLabel> = {
  Red: 'red',
  Orange: 'orange',
  Yellow: 'yellow',
  Green: 'green',
  Blue: 'blue',
  Purple: 'purple',
};

const VALID_FLAGS = new Set<string>(['pick', 'reject', 'unflagged']);

const isValidColorLabel = (s: string): boolean => isColorLabelValue(s);

/** `xmp:Rating`, clamped to the valid 0..5 integer range; 0 when absent/invalid. */
function parseRating(desc: Element): number {
  const ratingStr = attrOf(desc, ['xmp:Rating', 'Rating']);
  if (ratingStr === null) return 0;
  const n = Number(ratingStr);
  return !Number.isNaN(n) && n >= 0 && n <= 5 ? Math.round(n) : 0;
}

/** `maple:Flag` (canonical) with `papp:Flag` as fallback for interop. */
function parseFlag(desc: Element): XmpFlag {
  const flagStr = attrOf(desc, ['maple:Flag', 'papp:Flag', 'Flag']);
  return flagStr !== null && VALID_FLAGS.has(flagStr) ? (flagStr as XmpFlag) : 'unflagged';
}

/**
 * `xmp:Label` (XMP standard color word) with `maple:ColorLabel` (Maple's own
 * color names) as an override when both are present.
 */
function parseColorLabel(desc: Element): XmpColorLabel {
  const labelStr = attrOf(desc, ['xmp:Label', 'Label']);
  const fromLabel = labelStr !== null && labelStr in LABEL_MAP ? LABEL_MAP[labelStr] : null;

  const mapleLabel = attrOf(desc, ['maple:ColorLabel', 'papp:ColorLabel', 'ColorLabel']);
  const fromMapleLabel =
    mapleLabel !== null && isValidColorLabel(mapleLabel) ? (mapleLabel as XmpColorLabel) : null;

  return fromMapleLabel ?? fromLabel;
}

/** Parse `xmp:Rating` / `maple:Flag` / the two color-label attribute forms. */
function parseRatingFlagColorLabel(
  desc: Element,
): Pick<XmpCulling, 'rating' | 'flag' | 'colorLabel'> {
  return {
    rating: parseRating(desc),
    flag: parseFlag(desc),
    colorLabel: parseColorLabel(desc),
  };
}

/**
 * dc:subject — IPTC keyword bag (#632). Walks
 * `<dc:subject><rdf:Bag><rdf:li>kw</rdf:li>…</rdf:Bag></dc:subject>` and
 * extracts `rdf:li` text content in source order. Blank entries are
 * dropped — `dc:subject` rejects empty `rdf:li` content on the write path
 * too. Uses `getElementsByTagNameNS` so the prefix the sidecar binds to
 * the Dublin Core namespace (conventionally `dc:`) isn't load-bearing;
 * `getElementsByTagName('dc:subject')` is the fallback for parsers that
 * hand us prefix-only matches.
 */
function parseKeywordBag(desc: Element): string[] {
  const subjectEls = desc.getElementsByTagNameNS(DC_NAMESPACE, 'subject');
  const subjectEl =
    subjectEls.length > 0 ? subjectEls[0] : desc.getElementsByTagName('dc:subject')[0];
  if (!subjectEl) return [];

  // Dedupe at parse time (first occurrence wins, preserves source order)
  // so external / hand-edited sidecars carrying duplicate `rdf:li`
  // entries don't violate the uniqueness invariant the UI depends on
  // (e.g. Angular `@for ... track k`, Apple `ForEach(id: \.self)`).
  // Matches the write path's normalisation and the Apple parser's dedup
  // in `XMPSerialization.swift`.
  const keywords: string[] = [];
  const seen = new Set<string>();
  const liElsNS = subjectEl.getElementsByTagNameNS(RDF_NAMESPACE, 'li');
  const liEls = liElsNS.length > 0 ? liElsNS : subjectEl.getElementsByTagName('rdf:li');
  for (let i = 0; i < liEls.length; i++) {
    const text = (liEls[i].textContent ?? '').trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    keywords.push(text);
  }
  return keywords;
}

/**
 * Parse culling fields (rating / flag / colorLabel / IPTC keywords, #632)
 * from an already-located `rdf:Description` element. Returns safe defaults
 * for any field that is absent or unparseable — mirrors
 * `XmpParserService.parseCulling`'s pre-#2215 behaviour exactly.
 */
export function parseCullingBlock(desc: Element): XmpCulling {
  return {
    ...parseRatingFlagColorLabel(desc),
    keywords: parseKeywordBag(desc),
  };
}
