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
    culling?: { rating?: number; flag?: Flag | string; colorLabel?: ColorLabel | string | null },
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

    // DisplayLookCurve (#371) — emit only when divergent from the canonical
    // default ('Default'). Matches the Apple serializer's behaviour and
    // keeps sidecars compact for the common case.
    if (model.look && model.look !== 'Default') {
      parts.push(`papp:Look="${this._escapeAttr(model.look)}"`);
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
    const nestedSection = nestedNodes ? `\n${nestedNodes}\n` : '\n';

    return [
      '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Maple Hosted 0.1.0">',
      ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '  <rdf:Description rdf:about=""',
      '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
      '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
      '    xmlns:papp="http://ns.justmaple.app/photo/1.0/"',
      `${attrsBlock}>${nestedSection}  </rdf:Description>`,
      ' </rdf:RDF>',
      '</x:xmpmeta>',
      '<?xpacket end="w"?>',
    ].join('\n');
  }

  private _escapeAttr(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }
}
