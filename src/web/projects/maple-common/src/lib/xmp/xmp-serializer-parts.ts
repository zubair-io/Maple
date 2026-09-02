// xmp-serializer-parts.ts — attribute groups split out of
// `XmpSerializerService.serialize` (#1840, complexity hotspot): the
// single-attribute enum fields, the crop/straighten group, and the culling
// fields. Each is a pure `(value) => string[]` function with no shared
// state, mirroring the per-group split on the read side in
// `xmp-look-profile.ts` / `xmp-enum-attrs.ts` / `xmp-crop.ts`.

import type { AdjustmentModel, Crop } from '../models/adjustment-model';
import type { ColorLabel, Flag } from '../models/asset';
import type { PassthroughBucket, XmpMetadata } from './xmp.types';
import { metadataAttrParts } from './xmp-metadata';

/**
 * Minimal XML text-content escaping for `rdf:li` content (not attribute
 * content — attributes use `escapeXmpAttr` because every emitted attribute
 * is double-quoted, so `"` also matters there). Only `&`, `<`, `>` are
 * strictly required between tags.
 */
export function escapeXmpText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function escapeXmpAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Format a crop edge or angle value. 6 significant decimal places — matches
 * the reference renderer's output and keeps sidecars byte-interchangeable
 * for the crop group across platforms.
 */
function formatCropValue(v: number): string {
  return v.toFixed(6);
}

/** Highlight recovery / auto-exposure (#2214) — each emitted only on a non-default value. */
function highlightAndExposureParts(model: AdjustmentModel): string[] {
  const parts: string[] = [];

  if (model.highlightRecovery && model.highlightRecovery !== 'ChromaticAdaptation') {
    parts.push(`papp:HighlightRecoveryMode="${escapeXmpAttr(model.highlightRecovery)}"`);
  }
  if (model.autoExposure && model.autoExposure !== 'On') {
    parts.push(`papp:AutoExposure="${escapeXmpAttr(model.autoExposure)}"`);
  }

  return parts;
}

/**
 * The retired DisplayLookCurve `papp:Look` (#371/#443), its Auto Profile
 * successor `papp:Profile` (#536), and film emulation `papp:FilmLook`
 * (#2683). Each field is emitted only on a non-default value, mirroring the
 * Rust and Swift writers so pre-feature sidecars stay byte-identical.
 */
function lookProfileFilmParts(model: AdjustmentModel): string[] {
  const parts: string[] = [];

  if (model.look && model.look !== 'Default') {
    parts.push(`papp:Look="${escapeXmpAttr(model.look)}"`);
  }
  if (model.profile && model.profile !== 'Auto') {
    parts.push(`papp:Profile="${escapeXmpAttr(model.profile)}"`);
  }
  if (model.filmLook) {
    parts.push(`papp:FilmLook="${escapeXmpAttr(model.filmLook)}"`);
  }

  return parts;
}

/**
 * Hot/dead-pixel suppression (#1106), the DNG lens-corrections master switch
 * (#376), user white-balance method (#431/#2214), tone-curve application
 * mode (#436/#2214), and the black & white toggle (#276) — the decode/pixel
 * pipeline enum fields.
 */
function pixelPipelineEnumParts(model: AdjustmentModel): string[] {
  const parts: string[] = [];

  if (model.hotPixelSuppression && model.hotPixelSuppression !== 'Off') {
    parts.push(`papp:HotPixelSuppression="${escapeXmpAttr(model.hotPixelSuppression)}"`);
  }
  if (model.lensProfileEnable === 'Off') {
    parts.push(`crs:LensProfileEnable="0"`);
  }
  if (model.wbMethod && model.wbMethod !== 'Cat16') {
    parts.push(`papp:WbMethod="${escapeXmpAttr(model.wbMethod)}"`);
  }
  if (model.toneCurveMode && model.toneCurveMode !== 'PerChannel') {
    parts.push(`papp:ToneCurveMode="${escapeXmpAttr(model.toneCurveMode)}"`);
  }
  if (model.blackWhite === 'On') {
    parts.push('crs:ConvertToGrayscale="True"');
  }

  return parts;
}

export function enumFieldParts(model: AdjustmentModel): string[] {
  return [
    ...highlightAndExposureParts(model),
    ...lookProfileFilmParts(model),
    ...pixelPipelineEnumParts(model),
  ];
}

/**
 * Crop / straighten (#277, spec § 01 invariant 3). Emits the full rect group
 * only when non-identity. `angle` is independent — a pure straighten with no
 * rect trim emits angle but no HasCrop/rect fields.
 */
export function cropParts(crop: Crop | undefined): string[] {
  if (!crop) return [];
  const parts: string[] = [];
  const rectIsIdentity = crop.top === 0 && crop.left === 0 && crop.bottom === 1 && crop.right === 1;
  if (!rectIsIdentity) {
    parts.push('crs:HasCrop="True"');
    parts.push(`crs:CropTop="${formatCropValue(crop.top)}"`);
    parts.push(`crs:CropLeft="${formatCropValue(crop.left)}"`);
    parts.push(`crs:CropBottom="${formatCropValue(crop.bottom)}"`);
    parts.push(`crs:CropRight="${formatCropValue(crop.right)}"`);
    parts.push('crs:CropConstrainToWarp="0"');
  }
  if (crop.angle !== 0) {
    parts.push(`crs:CropAngle="${formatCropValue(crop.angle)}"`);
  }
  return parts;
}

/** Rating / flag / colorLabel — omitted at their default (0 / unflagged / null). */
export function cullingParts(culling?: {
  rating?: number;
  flag?: Flag | string;
  colorLabel?: ColorLabel | string | null;
}): string[] {
  const parts: string[] = [];
  if (culling?.rating && culling.rating > 0) {
    parts.push(`xmp:Rating="${culling.rating}"`);
  }
  if (culling?.flag && culling.flag !== 'unflagged') {
    parts.push(`papp:Flag="${culling.flag}"`);
  }
  if (culling?.colorLabel) {
    parts.push(`papp:ColorLabel="${culling.colorLabel}"`);
  }
  return parts;
}

/** Metadata block attributes (Batch Metadata, spec 2026-06-26), or none when no metadata was given. */
export function metadataAttrPartsOrEmpty(metadata: XmpMetadata | undefined): string[] {
  return metadata ? metadataAttrParts(metadata) : [];
}

/** Unknown attributes from the source sidecar, preserved verbatim. */
export function passthroughAttrParts(passthrough: PassthroughBucket | undefined): string[] {
  return (passthrough?.unknownAttributes ?? []).map(
    (attr) => `${attr.name}="${escapeXmpAttr(attr.value)}"`,
  );
}

/** The two passthrough node lists `canonicalDocument` splices in outside `rdf:Description`. */
export function passthroughDocumentNodes(passthrough: PassthroughBucket | undefined): {
  rdfNodes?: string[];
  xmpmetaNodes?: string[];
} {
  return { rdfNodes: passthrough?.unknownRdfNodes, xmpmetaNodes: passthrough?.unknownXmpmetaNodes };
}
