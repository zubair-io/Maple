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
import type { XmpCulling, PassthroughBucket } from './xmp.types';
import type { ColorLabel, Flag } from '../models/asset';
import { ADJUSTMENT_FIELDS, WB_PRESET_FIELD } from './xmp-fields';

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
  ): string {
    const parts: string[] = [];

    // Always-present bookkeeping attributes.
    parts.push('crs:Version="11.0"');
    parts.push('crs:ProcessVersion="11.0"');
    parts.push('crs:HasSettings="True"');

    // WhiteBalance preset (string field — emit unless "As Shot").
    if (model.whiteBalancePreset && model.whiteBalancePreset !== 'As Shot') {
      parts.push(`${WB_PRESET_FIELD.xmpKey}="${this._escapeAttr(model.whiteBalancePreset)}"`);
    }

    // Numeric adjustment fields — emit only when they differ from the default.
    for (const f of ADJUSTMENT_FIELDS) {
      const value = model[f.modelKey];
      if (value === undefined || value === null) continue;
      const defaultVal = f.defaultValue(model);
      if (value !== defaultVal) {
        parts.push(`${f.xmpKey}="${f.serialize(value)}"`);
      }
    }

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

    // Compose nested children: keywords first (canonical content), then
    // any unknown passthrough nodes the source sidecar carried.
    const childBlocks = [keywordsBlock, nestedNodes].filter((b) => b.length > 0).join('\n');
    const nestedSection = childBlocks ? `\n${childBlocks}\n` : '\n';

    // The `dc:` namespace declaration is only added when keywords are
    // present — keeps the attribute list quiet for the common "no
    // keywords" sidecar and avoids advertising namespaces we don't use.
    const dcNamespaceLine =
      keywords.length > 0 ? '\n    xmlns:dc="http://purl.org/dc/elements/1.1/"' : '';

    return [
      '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Maple Hosted 0.1.0">',
      ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '  <rdf:Description rdf:about=""',
      '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
      '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
      `    xmlns:papp="http://ns.justmaple.app/photo/1.0/"${dcNamespaceLine}`,
      `${attrsBlock}>${nestedSection}  </rdf:Description>`,
      ' </rdf:RDF>',
      '</x:xmpmeta>',
      '<?xpacket end="w"?>',
    ].join('\n');
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
}
