// XmpParserService — minimal culling-field parser for slice-10a.
//
// Reads:
//   xmp:Rating    → rating (0..5)
//   maple:Flag    → flag (pick/reject/unflagged)
//   xmp:Label     → colorLabel (Adobe's word → Maple enum)
//
// The authoritative full-schema XMP parser is a slice-7 deliverable.
// This version uses DOMParser for correctness over regex, but only extracts
// the fields that the browse grid and index.json need right now.

import { Injectable } from '@angular/core';
import type { XmpCulling, XmpFlag, XmpColorLabel } from './xmp.types';

/** Adobe xmp:Label words → Maple colorLabel values. */
const LABEL_MAP: Record<string, XmpColorLabel> = {
  Red:    'red',
  Orange: 'orange',
  Yellow: 'yellow',
  Green:  'green',
  Blue:   'blue',
};

const VALID_FLAGS = new Set<string>(['pick', 'reject', 'unflagged']);

@Injectable({ providedIn: 'root' })
export class XmpParserService {

  /**
   * Parse an XMP sidecar and extract culling fields.
   * Returns safe defaults for any field that is absent or unparseable.
   */
  parseCulling(xml: string): XmpCulling {
    const result: XmpCulling = {
      rating: 0,
      flag: 'unflagged',
      colorLabel: null,
    };

    let desc: Element | null = null;
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, 'text/xml');

      // Guard against parse errors (<parsererror> root).
      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        console.warn('XmpParserService: malformed XML');
        return result;
      }

      // rdf:Description may or may not have a namespace prefix, depending on
      // how the serialiser wrote it.
      desc =
        doc.querySelector('rdf\\:Description') ??
        doc.querySelector('Description');

      if (!desc) return result;
    } catch {
      return result;
    }

    // xmp:Rating
    const ratingStr = this._attr(desc, ['xmp:Rating', 'Rating']);
    if (ratingStr !== null) {
      const n = Number(ratingStr);
      if (!Number.isNaN(n) && n >= 0 && n <= 5) {
        result.rating = Math.round(n);
      }
    }

    // maple:Flag (canonical) with papp:Flag as fallback for interop.
    const flagStr = this._attr(desc, ['maple:Flag', 'papp:Flag', 'Flag']);
    if (flagStr !== null && VALID_FLAGS.has(flagStr)) {
      result.flag = flagStr as XmpFlag;
    }

    // xmp:Label (Adobe standard color word).
    const labelStr = this._attr(desc, ['xmp:Label', 'Label']);
    if (labelStr !== null && labelStr in LABEL_MAP) {
      result.colorLabel = LABEL_MAP[labelStr];
    }

    // maple:ColorLabel as an override (uses our color names directly).
    const mapleLabel = this._attr(desc, ['maple:ColorLabel', 'papp:ColorLabel', 'ColorLabel']);
    if (mapleLabel !== null && this._isValidColorLabel(mapleLabel)) {
      result.colorLabel = mapleLabel as XmpColorLabel;
    }

    return result;
  }

  /**
   * Try multiple attribute name variants (namespaced vs unprefixed).
   * DOMParser may or may not preserve namespace prefixes.
   */
  private _attr(el: Element, names: string[]): string | null {
    for (const name of names) {
      const val = el.getAttribute(name);
      if (val !== null) return val;
    }
    return null;
  }

  private _isValidColorLabel(s: string): boolean {
    return ['red', 'orange', 'yellow', 'green', 'blue'].includes(s);
  }
}
