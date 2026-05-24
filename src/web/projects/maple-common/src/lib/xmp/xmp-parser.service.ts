// XmpParserService — P6 extension: reads full AdjustmentModel + passthrough bucket.
//
// parseCulling()         — unchanged P5 path: rating / flag / colorLabel.
// parseAdjustmentModel() — new: reads all crs: numeric fields + WhiteBalance preset,
//                          and captures unknown attributes / nested elements for passthrough.

import { Injectable } from '@angular/core';
import type { XmpCulling, XmpFlag, XmpColorLabel, PassthroughBucket } from './xmp.types';
import type { AdjustmentModel, WhiteBalancePreset } from '../models/adjustment-model';
import type { Look } from '../generated/adjustment-model.generated';
import { ADJUSTMENT_FIELDS, WB_PRESET_FIELD } from './xmp-fields';

/** XMP xmp:Label words → Maple colorLabel values. */
const LABEL_MAP: Record<string, XmpColorLabel> = {
  Red: 'red',
  Orange: 'orange',
  Yellow: 'yellow',
  Green: 'green',
  Blue: 'blue',
};

const VALID_FLAGS = new Set<string>(['pick', 'reject', 'unflagged']);

/**
 * Attributes that Maple fully handles — used to separate the known set from
 * passthrough when collecting unknownAttributes.
 */
const KNOWN_ATTRIBUTES = new Set<string>([
  ...ADJUSTMENT_FIELDS.map((f) => f.xmpKey),
  WB_PRESET_FIELD.xmpKey,
  // culling
  'xmp:Rating',
  'Rating',
  'maple:Flag',
  'papp:Flag',
  'Flag',
  'xmp:Label',
  'Label',
  'maple:ColorLabel',
  'papp:ColorLabel',
  'ColorLabel',
  // DisplayLookCurve (#371) — parsed (read-side) here; serialize-side
  // landed in the same PR for Apple / raw-core. TS serializer support is
  // a follow-up alongside the Web Look picker UI.
  'papp:Look',
  // structural / bookkeeping
  'rdf:about',
  'crs:Version',
  'crs:ProcessVersion',
  'crs:HasSettings',
]);

@Injectable({ providedIn: 'root' })
export class XmpParserService {
  // ── Culling (unchanged P5 behaviour) ────────────────────────────────────────

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

      const parseError = doc.querySelector('parseerror');
      if (parseError) {
        console.warn('XmpParserService: malformed XML');
        return result;
      }

      desc = doc.querySelector('rdf\\:Description') ?? doc.querySelector('Description');

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

    // xmp:Label (XMP standard color word).
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

  // ── Full AdjustmentModel parser (P6) ────────────────────────────────────────

  /**
   * Parse a sidecar and return the develop adjustment fields plus a passthrough
   * bucket containing any attributes / elements that Maple does not model.
   * The returned `model` is a Partial — callers should merge over defaultAdjustmentModel().
   */
  parseAdjustmentModel(xml: string): {
    model: Partial<AdjustmentModel>;
    passthrough: PassthroughBucket;
  } {
    const emptyResult = {
      model: {} as Partial<AdjustmentModel>,
      passthrough: { unknownAttributes: [], unknownNodes: [] } as PassthroughBucket,
    };

    let desc: Element | null = null;
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, 'text/xml');

      // Guard against parse errors.
      if (doc.querySelector('parseerror')) {
        console.warn('XmpParserService.parseAdjustmentModel: malformed XML');
        return emptyResult;
      }

      desc = doc.querySelector('rdf\\:Description') ?? doc.querySelector('Description');

      if (!desc) return emptyResult;
    } catch {
      return emptyResult;
    }

    const model: Partial<AdjustmentModel> = {};

    // Walk all attributes on rdf:Description.
    for (let i = 0; i < desc.attributes.length; i++) {
      const attr = desc.attributes[i];
      const name = attr.name;

      const mapping = ADJUSTMENT_FIELDS.find((f) => f.xmpKey === name);
      if (mapping) {
        const parsed = mapping.parse(attr.value);
        if (!Number.isNaN(parsed)) {
          // Narrowed: every ADJUSTMENT_FIELDS entry is keyed on a numeric
          // AdjustmentModel field, so `parsed` is assignable to model[modelKey].
          model[mapping.modelKey] = parsed;
        }
        continue;
      }

      if (name === WB_PRESET_FIELD.xmpKey) {
        model.whiteBalancePreset = attr.value as WhiteBalancePreset;
        continue;
      }

      // DisplayLookCurve (#371). Case-insensitive parse matches the
      // Apple + Rust parsers. Unknown variants are silently dropped so
      // older sidecars never block sidecar load — the field then takes
      // its default ('Default').
      if (name === 'papp:Look') {
        const v = attr.value.toLowerCase();
        const parsed: Look | undefined =
          v === 'neutral' ? 'Neutral' : v === 'default' ? 'Default' : undefined;
        if (parsed !== undefined) {
          model.look = parsed;
        }
        continue;
      }
    }

    // Collect unknown attributes for the passthrough bucket.
    const unknownAttributes: Array<{ name: string; value: string }> = [];
    for (let i = 0; i < desc.attributes.length; i++) {
      const attr = desc.attributes[i];
      if (!KNOWN_ATTRIBUTES.has(attr.name) && !attr.name.startsWith('xmlns')) {
        unknownAttributes.push({ name: attr.name, value: attr.value });
      }
    }

    // Collect unknown child elements (ToneCurve, MaskGroupBasedCorrections, etc.).
    const unknownNodes: string[] = [];
    for (let i = 0; i < desc.children.length; i++) {
      unknownNodes.push(desc.children[i].outerHTML);
    }

    return {
      model,
      passthrough: { unknownAttributes, unknownNodes },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

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
