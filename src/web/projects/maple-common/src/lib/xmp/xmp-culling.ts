// xmp-culling.ts — culling (rating / flag / colorLabel) + IPTC `dc:subject`
// keyword-bag parser (#632). Split out of `XmpParserService.parseCulling`
// (#2215, file-size budget) — this half is pure (element in, `XmpCulling`
// out) so it's independently testable and round-trips without the DOM
// parse/error-handling wrapper that stays in the service.

import type { XmpCulling, XmpFlag, XmpColorLabel } from './xmp.types';
import { isColorLabelValue } from '../models/color-label';

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

/**
 * Parse culling fields (rating / flag / colorLabel / IPTC keywords, #632)
 * from an already-located `rdf:Description` element. Returns safe defaults
 * for any field that is absent or unparseable — mirrors
 * `XmpParserService.parseCulling`'s pre-#2215 behaviour exactly.
 */
export function parseCullingBlock(desc: Element): XmpCulling {
  const result: XmpCulling = {
    rating: 0,
    flag: 'unflagged',
    colorLabel: null,
    keywords: [],
  };

  const attr = (names: string[]): string | null => {
    for (const name of names) {
      const val = desc.getAttribute(name);
      if (val !== null) return val;
    }
    return null;
  };

  // xmp:Rating
  const ratingStr = attr(['xmp:Rating', 'Rating']);
  if (ratingStr !== null) {
    const n = Number(ratingStr);
    if (!Number.isNaN(n) && n >= 0 && n <= 5) {
      result.rating = Math.round(n);
    }
  }

  // maple:Flag (canonical) with papp:Flag as fallback for interop.
  const flagStr = attr(['maple:Flag', 'papp:Flag', 'Flag']);
  if (flagStr !== null && VALID_FLAGS.has(flagStr)) {
    result.flag = flagStr as XmpFlag;
  }

  // xmp:Label (XMP standard color word).
  const labelStr = attr(['xmp:Label', 'Label']);
  if (labelStr !== null && labelStr in LABEL_MAP) {
    result.colorLabel = LABEL_MAP[labelStr];
  }

  // maple:ColorLabel as an override (uses our color names directly).
  const mapleLabel = attr(['maple:ColorLabel', 'papp:ColorLabel', 'ColorLabel']);
  if (mapleLabel !== null && isValidColorLabel(mapleLabel)) {
    result.colorLabel = mapleLabel as XmpColorLabel;
  }

  // dc:subject — IPTC keyword bag (#632). Walks
  // `<dc:subject><rdf:Bag><rdf:li>kw</rdf:li>…</rdf:Bag></dc:subject>`
  // and extracts `rdf:li` text content in source order. Blank entries
  // are dropped — `dc:subject` rejects empty `rdf:li` content on the
  // write path too. Uses `getElementsByTagNameNS` so the prefix the
  // sidecar binds to the Dublin Core namespace (conventionally `dc:`)
  // isn't load-bearing; `getElementsByTagName('dc:subject')` is the
  // fallback for parsers that hand us prefix-only matches.
  const subjectEls = desc.getElementsByTagNameNS(DC_NAMESPACE, 'subject');
  const subjectEl =
    subjectEls.length > 0 ? subjectEls[0] : desc.getElementsByTagName('dc:subject')[0];
  if (subjectEl) {
    // Dedupe at parse time (first occurrence wins, preserves source
    // order) so external / hand-edited sidecars carrying duplicate
    // `rdf:li` entries don't violate the uniqueness invariant the UI
    // depends on (e.g. Angular `@for ... track k`, Apple
    // `ForEach(id: \.self)`). Matches the write path's normalisation
    // and the Apple parser's dedup in `XMPSerialization.swift`.
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
    result.keywords = keywords;
  }

  return result;
}
