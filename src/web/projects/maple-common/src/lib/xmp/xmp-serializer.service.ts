// XmpSerializerService — P6.
//
// Produces a Lightroom-readable .xmp sidecar for a given AdjustmentModel.
// Since #1577 the output is byte-canonical: the envelope, indentation,
// namespace declarations and attribute ordering all come from
// `xmp-canonical.ts`, which the Swift `XMPSerialization+Canonical.swift`
// mirrors byte-for-byte. `docs/xmp-canonical-format.md` is the contract.
//
// Spec guarantees:
//  - Standard xpacket header + x:xmpmeta + rdf:RDF + rdf:Description wrapper.
//  - crs:Version, crs:ProcessVersion, crs:HasSettings always emitted.
//  - Non-default fields only (fields matching defaults are omitted).
//  - Passthrough attributes and nested nodes preserved verbatim.
//  - <?xpacket end="w"?> trailer, LF line endings.

import { Injectable } from '@angular/core';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import type { PassthroughBucket, XmpMetadata } from './xmp.types';
import type { ColorLabel, Flag } from '../models/asset';
import { ADJUSTMENT_FIELDS, WB_PRESET_FIELD } from './xmp-fields';
import { toneCurveBlocks } from './xmp-tone-curves';
import { localAdjustmentBlocks } from './xmp-local-adjustments';
import { DESCRIPTION_CHILD_INDENT, canonicalDocument } from './xmp-canonical';
import {
  escapeXmpAttr,
  unescapeXmpAttr,
  enumFieldParts,
  cropParts,
  cullingParts,
  metadataAttrPartsOrEmpty,
  passthroughAttrParts,
  passthroughDocumentNodes,
} from './xmp-serializer-parts';
import {
  buildKeywordsBlock,
  composeNestedChildren,
  resolveExtraNamespaces,
} from './xmp-serializer-children';

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
    // Single-attribute enum fields (highlight recovery, auto-exposure,
    // Look/Profile, film emulation, hot-pixel suppression, lens-profile
    // switch, WB method, tone-curve mode, black & white) — see
    // `xmp-serializer-parts.ts`.
    parts.push(...enumFieldParts(model));
    // Crop / straighten (#277) — see `xmp-serializer-parts.ts`.
    parts.push(...cropParts(model.crop));
    // Rating / flag / colorLabel.
    parts.push(...cullingParts(culling));
    // Metadata block — simple attributes (Batch Metadata, spec 2026-06-26).
    // Inserted before passthrough so the fixed metadata order is stable.
    parts.push(...metadataAttrPartsOrEmpty(metadata));
    // Passthrough: unknown attributes from the source sidecar.
    parts.push(...passthroughAttrParts(passthrough));

    const indent = DESCRIPTION_CHILD_INDENT;

    // dc:subject — IPTC keyword bag (#632); see `xmp-serializer-children.ts`.
    const { block: keywordsBlock, filtered: keywords } = buildKeywordsBlock(
      culling?.keywords,
      indent,
    );

    // Point tone curves (#365) — nested `papp:SceneLinearToneCurve*` blocks,
    // emitted at the canonical child indent, the same ladder the keywords and
    // metadata blocks sit on. Identity curves emit nothing, so a model with
    // no authored curve keeps the pre-#365 bytes exactly. They sit before
    // the passthrough nodes so Maple-managed children stay grouped and any
    // imported `crs:ToneCurvePV2012*` (which rides the passthrough pipe)
    // keeps its position relative to the other unknown nodes.
    const toneCurvesBlock = toneCurveBlocks(model, indent);
    // Local adjustments (#358) — the canonical `crs:GradientBasedCorrections`
    // / `crs:CircularGradientBasedCorrections` containers, byte-identical to
    // raw-core's and Swift's emitters. An empty stack emits nothing.
    const localAdjustmentsBlock = localAdjustmentBlocks(model, indent);

    // Compose nested children in canonical slots — see `xmp-serializer-children.ts`.
    const children = composeNestedChildren({
      metadata,
      passthrough,
      keywordsBlock,
      toneCurvesBlock,
      localAdjustmentsBlock,
      indent,
    });

    // Namespace declarations: the canonical xmp/crs/papp prelude is emitted
    // by `canonicalDocument`; the rest — conditional metadata namespaces,
    // dc-for-keywords, and passthrough namespaces — comes from
    // `xmp-serializer-children.ts`.
    const extraNamespaces = resolveExtraNamespaces({
      metadata,
      hasKeywords: keywords.length > 0,
      unknownNamespaces: passthrough?.unknownNamespaces,
    });

    return canonicalDocument(
      extraNamespaces,
      parts,
      children,
      passthroughDocumentNodes(passthrough),
    );
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
  /**
   * Every canonical attribute this writer would emit for `model` that
   * differs from what it emits for the default model — the adjustment,
   * enum, and crop attributes — plus the nested tone-curve block under the
   * synthetic key `toneCurves` (curves are children, not attributes). The
   * edit-transaction sidecar diff (#2432, `editor/edit-transaction.ts`) is
   * computed over this map, so a diff is expressed in the exact bytes the
   * sidecar carries; Apple computes the same map from its own writer
   * (`SidecarDiff.attributes(of:)`), subtracting its unconditional
   * core-block emission so both maps are omit-on-default
   * (docs/xmp-canonical-format.md § "Known divergence").
   */
  modelAttributes(model: AdjustmentModel): ReadonlyMap<string, string> {
    const defaults = this._attributeMap(defaultAdjustmentModel());
    const out = new Map<string, string>();
    for (const [key, value] of this._attributeMap(model)) {
      if (defaults.get(key) !== value) out.set(key, value);
    }
    const curves = toneCurveBlocks(model, '');
    if (curves) out.set('toneCurves', curves);
    return out;
  }

  private _attributeMap(model: AdjustmentModel): Map<string, string> {
    const out = new Map<string, string>();
    const parts = [
      ...this._adjustmentParts(model),
      ...enumFieldParts(model),
      ...cropParts(model.crop),
    ];
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      out.set(part.slice(0, eq), unescapeXmpAttr(part.slice(eq + 2, -1)));
    }
    return out;
  }

  private _adjustmentParts(model: AdjustmentModel): string[] {
    const parts: string[] = [];

    // WhiteBalance preset (string field — emit unless "As Shot").
    if (model.whiteBalancePreset && model.whiteBalancePreset !== 'As Shot') {
      parts.push(`${WB_PRESET_FIELD.xmpKey}="${escapeXmpAttr(model.whiteBalancePreset)}"`);
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
      // A `NaN`/`Infinity`/`-Infinity` model value (a corrupted in-memory
      // model, or a hand-edited/malicious sidecar that round-tripped one
      // through the parser before this guard existed) is never
      // representable in XMP and must never be written — matches
      // `raw-core`'s and Swift's rejection of non-finite numeric values on
      // write (docs/xmp-canonical-format.md § "Number formatting", #3186).
      if (!Number.isFinite(value)) continue;
      // Omit-on-default compares the serialized wire forms, not the raw
      // values: the codec rounds to 2 decimals, so a raw comparison would
      // emit the default wire value for near-default inputs (0.004 →
      // `="0"`), churning otherwise-identical sidecars (PR #2192 review).
      const wire = f.serialize(value);
      if (wire !== f.serialize(f.defaultValue(model))) {
        fieldParts.push(`${f.xmpKey}="${wire}"`);
        emittedKeys.add(f.xmpKey);
      }
    }
    return { fieldParts, emittedKeys };
  }
}
