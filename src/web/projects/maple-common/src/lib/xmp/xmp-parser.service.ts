// XmpParserService — P6 extension: reads full AdjustmentModel + passthrough bucket.
//
// parseCulling()         — rating / flag / colorLabel + IPTC `dc:subject`
//                          keyword bag (#632).
// parseAdjustmentModel() — reads all crs: numeric fields + WhiteBalance preset,
//                          and captures unknown attributes / nested elements
//                          for passthrough — `dc:subject` is explicitly
//                          excluded from the passthrough child list so the
//                          serializer doesn't double-emit it.

import { Injectable } from '@angular/core';
import type { XmpCulling, PassthroughBucket, XmpMetadata } from './xmp.types';
import type { AdjustmentModel } from '../models/adjustment-model';
import { resolveWbScaleVersion, normalizeParsedWb } from './xmp-wb-scale';
import { parseMetadataBlock } from './xmp-metadata';
import { parseCullingBlock } from './xmp-culling';
import { collectXmpPassthrough } from './xmp-passthrough';
import { finalizeCrop } from './xmp-crop';
import { walkAdjustmentAttributes, applyLegacyAliases } from './xmp-adjustment-walk';
import {
  attrOf,
  hasXmlParseError,
  mergedXmpDescription,
  primaryXmpDescription,
  sawMapleAuthorshipMarker,
} from './xmp-dom-utils';

@Injectable({ providedIn: 'root' })
export class XmpParserService {
  // ── Culling (unchanged P5 behaviour) ────────────────────────────────────────

  /**
   * Parse an XMP sidecar and extract culling fields.
   * Returns safe defaults for any field that is absent or unparseable. The
   * field-by-field walk is `parseCullingBlock` in `xmp-culling.ts` (#2215,
   * file-size budget) — this method owns only the XML → `rdf:Description`
   * lookup + the malformed-XML default.
   */
  parseCulling(xml: string): XmpCulling {
    const defaults: XmpCulling = { rating: 0, flag: 'unflagged', colorLabel: null, keywords: [] };
    let desc: Element | null = null;
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (hasXmlParseError(doc)) {
        console.warn('XmpParserService: malformed XML');
        return defaults;
      }
      desc = mergedXmpDescription(doc);
      if (!desc) return defaults;
    } catch {
      return defaults;
    }
    return parseCullingBlock(desc);
  }

  // ── Metadata block (Batch Metadata, spec 2026-06-26) ────────────────────────

  /**
   * Parse the IPTC/EXIF metadata block. Returns only the fields present;
   * absent fields are left undefined. The field-by-field walk is
   * `parseMetadataBlock` in `xmp-metadata.ts` (#2215, file-size budget) —
   * this method owns only the XML → `rdf:Description` lookup.
   */
  parseMetadata(xml: string): XmpMetadata {
    let desc: Element | null = null;
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (hasXmlParseError(doc)) return {};
      desc = mergedXmpDescription(doc);
    } catch {
      return {};
    }
    if (!desc) return {};
    return parseMetadataBlock(desc);
  }

  // ── Full AdjustmentModel parser (P6) ────────────────────────────────────────

  /**
   * Parse a sidecar and return the develop adjustment fields plus a passthrough
   * bucket containing any attributes / elements that Maple does not model.
   * The returned `model` is a Partial — callers should merge over defaultAdjustmentModel().
   *
   * The XML → `rdf:Description` bootstrap is `_parseAdjustmentDocument`
   * below; the attribute walk (canonical fields + per-group dispatch +
   * legacy aliases) is `walkAdjustmentAttributes` / `applyLegacyAliases` in
   * `xmp-adjustment-walk.ts` (#1840), which in turn delegates to
   * `xmp-look-profile.ts` / `xmp-enum-attrs.ts` / `xmp-crop.ts` for the
   * individual field groups. This method owns the WB-scale and crop
   * bootstrapping those need, and the post-walk normalization passes.
   */
  parseAdjustmentModel(xml: string): {
    model: Partial<AdjustmentModel>;
    passthrough: PassthroughBucket;
  } {
    const emptyResult = {
      model: {} as Partial<AdjustmentModel>,
      passthrough: { unknownAttributes: [], unknownNodes: [] } as PassthroughBucket,
    };

    const parsed = this._parseAdjustmentDocument(xml);
    if (!parsed) return emptyResult;
    const { desc, sourceDescription, document, sawPappAnywhere } = parsed;

    // Crop gating (#277) — see `xmp-crop.ts`. `crs:HasCrop` must be known
    // before the rect fields are applied, so it's read up front here.
    const hasCropAttr = attrOf(desc, ['crs:HasCrop']);
    const hasCrop = hasCropAttr === 'True' || hasCropAttr === 'true';

    // WB scale versioning (#1780/#1875/#1894) — rationale in `xmp-wb-scale.ts`.
    const wbScale = resolveWbScaleVersion(desc, sawPappAnywhere);

    const { model, canonicallyApplied, legacyDeferred, cropAcc } = walkAdjustmentAttributes(
      desc,
      hasCrop,
    );
    model.wbScaleVersion = wbScale.modelVersion;
    applyLegacyAliases(model, legacyDeferred, canonicallyApplied);

    // Post-walk WB load-normalization + Custom-preset inference — see
    // `normalizeParsedWb`'s doc in `xmp-wb-scale.ts` for the full
    // rationale (V2/V3/V4 → V5 joint-pair conversion gated on the
    // attribute-presence record, and the #1892 authored-pair → 'Custom'
    // inference).
    normalizeParsedWb(model, canonicallyApplied, wbScale);

    // Emit `crop` only when any field came through; angle alone is enough
    // (pure straighten). Identity default is applied for absent fields.
    const crop = finalizeCrop(cropAcc);
    if (crop) {
      model.crop = crop;
    }

    return {
      model,
      passthrough: collectXmpPassthrough(sourceDescription ?? desc, model, document),
    };
  }

  /**
   * Parses `xml`, guards against malformed documents, and resolves the
   * merged `rdf:Description` plus the Maple-authorship marker
   * `resolveWbScaleVersion` needs. Returns `null` on any parse failure —
   * the caller falls back to its `emptyResult`.
   */
  private _parseAdjustmentDocument(xml: string): {
    desc: Element;
    sourceDescription: Element | null;
    document: Document;
    sawPappAnywhere: boolean;
  } | null {
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (hasXmlParseError(doc)) {
        console.warn('XmpParserService.parseAdjustmentModel: malformed XML');
        return null;
      }

      const desc = mergedXmpDescription(doc);
      if (!desc) return null;

      return {
        desc,
        sourceDescription: primaryXmpDescription(doc),
        document: doc,
        sawPappAnywhere: sawMapleAuthorshipMarker(doc),
      };
    } catch {
      return null;
    }
  }
}
