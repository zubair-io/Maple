// XmpSerializerService — P6.
//
// Produces a Lightroom-readable .xmp sidecar for a given AdjustmentModel.
// Output is semantically round-trippable but NOT byte-canonical; byte-exact
// output is deferred to slice 7.
//
// Spec guarantees:
//  - Standard xpacket header + x:xmpmeta + rdf:RDF + rdf:Description wrapper.
//  - crs:Version, crs:ProcessVersion, crs:HasSettings always emitted.
//  - Non-default fields only (fields matching defaults are omitted).
//  - Passthrough attributes and nested nodes preserved verbatim.
//  - <?xpacket end="w"?> trailer, LF line endings.

import { Injectable } from '@angular/core';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling, PassthroughBucket, XmpMetadata } from './xmp.types';
import type { ColorLabel, Flag } from '../models/asset';
import { ADJUSTMENT_FIELDS, WB_PRESET_FIELD } from './xmp-fields';
import {
  metadataAttrParts,
  metadataNestedBlocks,
  metadataNamespacePrefixes,
  METADATA_NAMESPACES,
} from './xmp-metadata';

@Injectable({ providedIn: 'root' })
export class XmpSerializerService {
  /**
   * Serialize an AdjustmentModel to a Lightroom-compatible XMP string.
   *
   * @param model      Full develop settings for the asset.
   * @param passthrough  Unknown attributes / nested nodes from the source sidecar (optional).
   * @param culling    Rating / flag / colorLabel (optional; omitted when all default).
   */
  serialize(
    model: AdjustmentModel,
    passthrough?: PassthroughBucket,
    culling?: {
      rating?: number;
      flag?: Flag | string;
      colorLabel?: ColorLabel | string | null;
      /** IPTC keywords (#632) — emitted as a nested `dc:subject` element. */
      keywords?: readonly string[];
    },
    metadata?: XmpMetadata,
  ): string {
    const parts: string[] = [];

    // Always-present bookkeeping attributes.
    parts.push('crs:Version="11.0"');
    parts.push('crs:ProcessVersion="11.0"');
    parts.push('crs:HasSettings="True"');

    parts.push(...this._adjustmentParts(model));

    // DisplayLookCurve (#371; retired in #443) — the field is a no-op
    // post-#443 but the attribute is still emitted on non-default values
    // so pre-#443 sidecars round-trip. Default-valued models omit the
    // attribute, so newly-saved sidecars carry no `papp:Look` at all.
    if (model.look && model.look !== 'Default') {
      parts.push(`papp:Look="${this._escapeAttr(model.look)}"`);
    }

    // Auto Profile (Phase 1, #536). Canonical successor to the retired
    // `papp:Look` — pure enum-string field with default 'Auto'. Mirrors
    // raw-core's `serialize()` (xmp/mod.rs): only emit when non-default,
    // and the legacy `papp:Look` is intentionally NOT mirrored on write —
    // newly-saved sidecars carry only the new attribute name.
    if (model.profile && model.profile !== 'Auto') {
      parts.push(`papp:Profile="${this._escapeAttr(model.profile)}"`);
    }

    // Hot/dead-pixel suppression (#1106) — decode-product enum field,
    // default 'Off'. Emit only when non-default, mirroring the Rust and
    // Swift writers, so pre-#1106 sidecars stay byte-identical.
    if (model.hotPixelSuppression && model.hotPixelSuppression !== 'Off') {
      parts.push(`papp:HotPixelSuppression="${this._escapeAttr(model.hotPixelSuppression)}"`);
    }

    // Crop / straighten (#277, spec § 01 invariant 3). Emit the full group
    // only when non-identity. CropAngle is independent — a pure straighten
    // with no rect trim emits angle but no HasCrop/rect fields. Mirrors the
    // Rust `serialize()` in xmp/mod.rs and the Swift XMP writer.
    if (model.crop) {
      const c = model.crop;
      const rectIsIdentity = c.top === 0 && c.left === 0 && c.bottom === 1 && c.right === 1;
      if (!rectIsIdentity) {
        parts.push('crs:HasCrop="True"');
        parts.push(`crs:CropTop="${this._fmtCrop(c.top)}"`);
        parts.push(`crs:CropLeft="${this._fmtCrop(c.left)}"`);
        parts.push(`crs:CropBottom="${this._fmtCrop(c.bottom)}"`);
        parts.push(`crs:CropRight="${this._fmtCrop(c.right)}"`);
        parts.push('crs:CropConstrainToWarp="0"');
      }
      if (c.angle !== 0) {
        parts.push(`crs:CropAngle="${this._fmtCrop(c.angle)}"`);
      }
    }

    // Culling fields.
    if (culling?.rating && culling.rating > 0) {
      parts.push(`xmp:Rating="${culling.rating}"`);
    }
    if (culling?.flag && culling.flag !== 'unflagged') {
      parts.push(`papp:Flag="${culling.flag}"`);
    }
    if (culling?.colorLabel) {
      parts.push(`papp:ColorLabel="${culling.colorLabel}"`);
    }

    // Metadata block — simple attributes (Batch Metadata, spec 2026-06-26).
    // Inserted before passthrough so the fixed metadata order is stable.
    if (metadata) {
      for (const part of metadataAttrParts(metadata)) {
        parts.push(part);
      }
    }

    // Passthrough: unknown attributes from the source sidecar.
    if (passthrough) {
      for (const attr of passthrough.unknownAttributes) {
        parts.push(`${attr.name}="${this._escapeAttr(attr.value)}"`);
      }
    }

    // Build the attribute block — each on its own indented line.
    const attrsBlock = parts.map((p) => `   ${p}`).join('\n');

    // Passthrough: unknown nested nodes (ToneCurve, etc.) — indented inside rdf:Description.
    const nestedNodes = (passthrough?.unknownNodes ?? []).map((n) => `  ${n}`).join('\n');

    // dc:subject — IPTC keyword bag (#632). Emitted as a nested
    // `<dc:subject><rdf:Bag><rdf:li>…</rdf:Bag></dc:subject>` block when
    // the culling object carries any keywords. An empty / undefined list
    // omits the element so the round-trip empty → no element → empty
    // matches the read path's "no element" default and matches Apple's
    // `XMPSerializer` behaviour.
    const keywords = (culling?.keywords ?? []).filter((k) => k && k.trim().length > 0);
    const keywordsBlock =
      keywords.length === 0
        ? ''
        : [
            '  <dc:subject>',
            '   <rdf:Bag>',
            ...keywords.map((k) => `    <rdf:li>${this._escapeText(k)}</rdf:li>`),
            '   </rdf:Bag>',
            '  </dc:subject>',
          ].join('\n');

    // Metadata nested elements (lang-alt / seq), in fixed order.
    const metadataBlocks = metadata ? metadataNestedBlocks(metadata) : [];

    // Compose nested children in canonical slots: metadata
    // title/creator/description first, then keywords (dc:subject), then
    // metadata rights/usageTerms, then any unknown passthrough nodes.
    const titleCreatorDesc = metadataBlocks.filter((b) =>
      /^ {2}<(dc:title|dc:creator|dc:description)>/.test(b),
    );
    const rightsUsage = metadataBlocks.filter((b) =>
      /^ {2}<(dc:rights|xmpRights:UsageTerms)>/.test(b),
    );
    const childBlocks = [
      titleCreatorDesc.join('\n'),
      keywordsBlock,
      rightsUsage.join('\n'),
      nestedNodes,
    ]
      .filter((b) => b.length > 0)
      .join('\n');
    const nestedSection = childBlocks ? `\n${childBlocks}\n` : '\n';

    // Namespace declarations: always xmp/crs/papp; then conditional metadata
    // namespaces plus dc-for-keywords, in fixed prefix order. Keeps the
    // attribute list quiet for sidecars that use none of them.
    const usedPrefixes = metadata ? metadataNamespacePrefixes(metadata) : new Set<string>();
    if (keywords.length > 0) usedPrefixes.add('dc');
    const NS_ORDER = ['dc', 'exif', 'photoshop', 'Iptc4xmpCore', 'xmpRights'];
    const extraNsLines = NS_ORDER.filter((p) => usedPrefixes.has(p))
      .map((p) => `\n    xmlns:${p}="${METADATA_NAMESPACES[p]}"`)
      .join('');

    return [
      '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Maple Hosted 0.1.0">',
      ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '  <rdf:Description rdf:about=""',
      '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
      '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
      `    xmlns:papp="http://ns.justmaple.app/photo/1.0/"${extraNsLines}`,
      `${attrsBlock}>${nestedSection}  </rdf:Description>`,
      ' </rdf:RDF>',
      '</x:xmpmeta>',
      '<?xpacket end="w"?>',
    ].join('\n');
  }

  /**
   * WhiteBalance preset + numeric adjustment fields + the WB scale stamp.
   *
   * An As-Shot model's temperature/tint are the camera's display seed
   * (`seedAsShotWhiteBalance`), not authored values — emitting them would
   * demote the render's exact As-Shot sentinel (absent crs:Temperature/
   * crs:Tint) into a float-rounded explicit target and pollute the sidecar
   * with estimator output (#1892). Any real WB edit flips the preset to
   * 'Custom' (LibraryStore.setAdjustment) or a named preset, both of which
   * serialize the pair.
   *
   * WB scale stamp (#1780/#1875/#1893/#1894): whenever an explicit
   * Temperature/Tint is emitted, the scale those numbers are expressed in
   * rides along. V1 re-emits as 1 (raw-core converts at develop, so stored
   * V1 values keep their meaning across saves); everything else emits 5 —
   * the parse normalizes V2/V3/V4 models to V5 at load, so a non-1 model
   * always holds V5 (Robertson-native) values. Clamped to {1, 5}:
   * raw-core's parser hard-fails on an unknown stamp, so a corrupted/
   * out-of-range model field must never reach the sidecar. Mirrors the
   * Swift writer.
   */
  private _adjustmentParts(model: AdjustmentModel): string[] {
    const parts: string[] = [];

    // WhiteBalance preset (string field — emit unless "As Shot").
    if (model.whiteBalancePreset && model.whiteBalancePreset !== 'As Shot') {
      parts.push(`${WB_PRESET_FIELD.xmpKey}="${this._escapeAttr(model.whiteBalancePreset)}"`);
    }

    const wbIsAsShot = !model.whiteBalancePreset || model.whiteBalancePreset === 'As Shot';
    const { fieldParts, emittedKeys } = this._numericFieldParts(model, wbIsAsShot);
    parts.push(...fieldParts);

    if (emittedKeys.has('crs:Temperature') || emittedKeys.has('crs:Tint')) {
      parts.push(`papp:WbScaleVersion="${model.wbScaleVersion === 1 ? 1 : 5}"`);
    }

    return parts;
  }

  /**
   * Numeric adjustment fields — emitted only when they differ from the
   * default. `wbIsAsShot` skips temperature/tint entirely (the display
   * seed — see `_adjustmentParts`'s doc). `emittedKeys` lets the caller
   * decide whether the WB scale stamp must ride along.
   */
  private _numericFieldParts(
    model: AdjustmentModel,
    wbIsAsShot: boolean,
  ): { fieldParts: string[]; emittedKeys: Set<string> } {
    const fieldParts: string[] = [];
    const emittedKeys = new Set<string>();
    for (const f of ADJUSTMENT_FIELDS) {
      if (wbIsAsShot && (f.modelKey === 'temperature' || f.modelKey === 'tint')) continue;
      const value = model[f.modelKey];
      if (value === undefined || value === null) continue;
      if (value !== f.defaultValue(model)) {
        fieldParts.push(`${f.xmpKey}="${f.serialize(value)}"`);
        emittedKeys.add(f.xmpKey);
      }
    }
    return { fieldParts, emittedKeys };
  }

  /**
   * Minimal XML text-content escaping for `rdf:li` content (not attribute
   * content — attributes use `_escapeAttr` because `"` and `'` matter
   * there). Only `&`, `<`, `>` are strictly required between tags.
   */
  private _escapeText(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  private _escapeAttr(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  /**
   * Format a crop edge or angle value. 6 significant decimal places —
   * matches the reference renderer's output and keeps sidecars
   * byte-interchangeable for the crop group across platforms.
   */
  private _fmtCrop(v: number): string {
    return v.toFixed(6);
  }
}
