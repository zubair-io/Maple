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
import type { AdjustmentModel, WhiteBalancePreset, Crop } from '../models/adjustment-model';
import type {
  AutoExposureMode,
  BlackWhiteMode,
  HighlightRecoveryMode,
  HotPixelSuppressionMode,
  Look,
  Profile,
  ToneCurveMode,
  WbMethod,
} from '../generated/adjustment-model.generated';
import { ADJUSTMENT_FIELDS, LEGACY_READ_ALIASES, WB_PRESET_FIELD } from './xmp-fields';
import { resolveWbScaleVersion, normalizeParsedWb } from './xmp-wb-scale';
import { parseMetadataBlock, METADATA_ATTR_KEYS, METADATA_NESTED_ELEMENTS } from './xmp-metadata';
import { DC_NAMESPACE, parseCullingBlock } from './xmp-culling';
import { parseToneCurveElement, toneCurveElementKey } from './xmp-tone-curves';

/**
 * Precomputed `xmpKey → alias` lookup for `LEGACY_READ_ALIASES`. Used by both
 * passes in `parseAdjustmentModel()` to replace per-attribute `Array.some` /
 * `Array.find` scans with O(1) `Map.get`. Sidecars routinely carry 30+
 * attributes so the constant factor matters even at the current 1-entry
 * alias table.
 */
const LEGACY_READ_ALIASES_MAP = new Map(LEGACY_READ_ALIASES.map((a) => [a.xmpKey, a]));

/**
 * Wire variants for `papp:HighlightRecoveryMode` (#2214). The list must stay
 * exhaustive against the generated union — the `satisfies` record makes a
 * missing variant a compile error when codegen adds one, so the TS parser
 * can't silently lag raw-core's `xmp/mod.rs` match arms.
 */
const HIGHLIGHT_RECOVERY_MODES = Object.keys({
  Off: true,
  Blend: true,
  Luminance: true,
  ChromaticAdaptation: true,
  OklabChromaReduction: true,
} satisfies Record<HighlightRecoveryMode, true>) as readonly HighlightRecoveryMode[];

/** Case-insensitive wire → canonical variant match, or undefined if unknown. */
const matchVariant = <T extends string>(variants: readonly T[], raw: string): T | undefined => {
  const lower = raw.toLowerCase();
  return variants.find((v) => v.toLowerCase() === lower);
};

/**
 * Attributes that Maple fully handles — used to separate the known set from
 * passthrough when collecting unknownAttributes.
 */
const KNOWN_ATTRIBUTES = new Set<string>([
  ...ADJUSTMENT_FIELDS.map((f) => f.xmpKey),
  ...LEGACY_READ_ALIASES.map((f) => f.xmpKey),
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
  // DisplayLookCurve (#371; retired in #443) — kept here so pre-#443
  // sidecars carrying `papp:Look` round-trip cleanly into the model
  // (field is a no-op at the pipeline level post-#443).
  'papp:Look',
  // Auto Profile (Phase 1, #536) — canonical successor to `papp:Look`.
  'papp:Profile',
  // Hot/dead-pixel suppression (#1106) — decode-product enum field.
  'papp:HotPixelSuppression',
  // Enum mode fields (#2214) — parsed into the model and re-emitted by the
  // serializer, so they must stay out of the passthrough bucket
  // (double-emit otherwise).
  'papp:HighlightRecoveryMode',
  'papp:AutoExposure',
  'papp:WbMethod',
  'papp:ToneCurveMode',
  // Black & white toggle (#276) — ACR/Lightroom-compatible `crs:` key,
  // parsed into `blackWhite` and re-emitted by the serializer, so it must
  // stay out of the passthrough bucket (double-emit otherwise). The 8
  // gray-mixer weights are already covered via `ADJUSTMENT_FIELDS` above.
  'crs:ConvertToGrayscale',
  // WB slider-scale version (#1780) — parsed into `wbScaleVersion` and
  // re-emitted by the serializer alongside explicit Temperature/Tint, so
  // it must stay out of the passthrough bucket (double-emit otherwise).
  'papp:WbScaleVersion',
  // Crop / straighten group (ticket #277)
  'crs:HasCrop',
  'crs:CropTop',
  'crs:CropLeft',
  'crs:CropBottom',
  'crs:CropRight',
  'crs:CropAngle',
  'crs:CropConstrainToWarp',
  // structural / bookkeeping
  'rdf:about',
  'crs:Version',
  'crs:ProcessVersion',
  'crs:HasSettings',
  // Batch Metadata block (spec 2026-06-26) — keep these out of passthrough.
  ...METADATA_ATTR_KEYS,
]);

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
      if (doc.querySelector('parseerror')) {
        console.warn('XmpParserService: malformed XML');
        return defaults;
      }
      desc = doc.querySelector('rdf\\:Description') ?? doc.querySelector('Description');
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
      if (doc.querySelector('parseerror')) return {};
      desc = doc.querySelector('rdf\\:Description') ?? doc.querySelector('Description');
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
   */
  // Pre-existing complexity, unmodified by #2215's file-budget split — this
  // change only removes `parseCulling`/`parseMetadata`'s bodies (relocated
  // to `xmp-culling.ts` / `xmp-metadata.ts`) above this method, which shifts
  // its line number and drops fallow's positional inherited-finding match.
  // No branches here changed. Tracked for a real decomposition separately.
  // fallow-ignore-next-line complexity
  parseAdjustmentModel(xml: string): {
    model: Partial<AdjustmentModel>;
    passthrough: PassthroughBucket;
  } {
    const emptyResult = {
      model: {} as Partial<AdjustmentModel>,
      passthrough: { unknownAttributes: [], unknownNodes: [] } as PassthroughBucket,
    };

    let desc: Element | null = null;
    let sawPappAnywhere = false;
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

      // Maple-authorship marker (#1780): raw-core and the Swift parser
      // record the `papp:` namespace from ANY element (declaration or
      // attribute) — a writer may declare `xmlns:papp` on an outer
      // element like `x:xmpmeta`, not just `rdf:Description`. Computed
      // here, where the whole Document is in scope; consumed by the WB
      // scale-version resolution below.
      sawPappAnywhere = Array.from(doc.getElementsByTagName('*')).some((el) =>
        Array.from(el.attributes).some(
          (a) => a.name === 'xmlns:papp' || a.name.startsWith('papp:'),
        ),
      );
    } catch {
      return emptyResult;
    }

    const model: Partial<AdjustmentModel> = {};
    // Tracks model keys already populated from a canonical
    // `ADJUSTMENT_FIELDS` entry so a `LEGACY_READ_ALIASES` mapping never
    // overwrites them. Matches raw-core's `sigma_seen` precedence (#463):
    // when both `papp:CaptureSharpeningSigma` and the legacy
    // `papp:CaptureSharpeningRadius` are present, sigma always wins.
    const canonicallyApplied = new Set<keyof AdjustmentModel>();

    // Auto Profile (#536): the new `papp:Profile` wins over the legacy
    // `papp:Look` migration when both appear on the same element, regardless
    // of document order. Mirrors raw-core's `profile_seen` flag pattern in
    // `xmp/mod.rs` — Profile always overwrites when seen; the flag blocks a
    // later Look from clobbering an earlier Profile.
    let profileSeen = false;

    // Crop gating (#277): crs:HasCrop must be discovered before applying the
    // rect fields — mirrors the two-pass approach in raw-core's xmp/mod.rs.
    // crs:CropAngle is independent of HasCrop (pure straighten; spec § 01
    // invariant 3). Missing or "False" → leave crop at identity default.
    const hasCropAttr = desc.getAttribute('crs:HasCrop');
    const hasCrop = hasCropAttr === 'True' || hasCropAttr === 'true';
    let cropTop: number | undefined;
    let cropLeft: number | undefined;
    let cropBottom: number | undefined;
    let cropRight: number | undefined;
    let cropAngle: number | undefined;

    // WB scale versioning (#1780/#1875/#1894) — rationale in `xmp-wb-scale.ts`.
    const wbScale = resolveWbScaleVersion(desc, sawPappAnywhere);
    model.wbScaleVersion = wbScale.modelVersion;

    // Pass 1: walk attributes, applying canonical fields and remembering
    // legacy-aliased attributes for a second pass.
    const legacyDeferred: Array<{ name: string; value: string }> = [];
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
          canonicallyApplied.add(mapping.modelKey);
        }
        continue;
      }

      if (LEGACY_READ_ALIASES_MAP.has(name)) {
        legacyDeferred.push({ name, value: attr.value });
        continue;
      }

      if (name === WB_PRESET_FIELD.xmpKey) {
        model.whiteBalancePreset = attr.value as WhiteBalancePreset;
        continue;
      }

      // DisplayLookCurve (#371; retired in #443). Case-insensitive parse
      // matches the Apple + Rust parsers. Unknown variants are silently
      // dropped so older sidecars never block sidecar load — the field
      // then takes its default ('Default'). The field is a no-op at the
      // pipeline level post-#443; parsed purely for sidecar back-compat.
      //
      // Auto Profile (#536): when `papp:Profile` has not yet been seen on
      // this element, `papp:Look` also migrates into the new `profile`
      // field — Default/Auto → 'Auto', Neutral → 'Neutral'. The migration
      // reads `attr.value` (not `parsed`) because `Look="Auto"` is a valid
      // legacy value that doesn't have a TS Look variant; we still want
      // it to migrate. Mirrors raw-core's `xmp/mod.rs` Look→Profile arm.
      if (name === 'papp:Look') {
        const v = attr.value.toLowerCase();
        const parsed: Look | undefined =
          v === 'neutral' ? 'Neutral' : v === 'default' ? 'Default' : undefined;
        if (parsed !== undefined) {
          model.look = parsed;
        }
        if (!profileSeen) {
          if (v === 'default' || v === 'auto') {
            model.profile = 'Auto';
          } else if (v === 'neutral') {
            model.profile = 'Neutral';
          }
        }
        continue;
      }

      // Auto Profile (Phase 1, #536). Canonical render-shaping profile.
      // Case-insensitive parse matches raw-core. Unknown values fall back
      // to 'Auto' so a forward-compat sidecar from a newer build doesn't
      // block sidecar load. Setting `profileSeen` blocks the legacy
      // `papp:Look` migration from clobbering this value if Look appears
      // later in the same attribute set.
      if (name === 'papp:Profile') {
        profileSeen = true;
        const v = attr.value.toLowerCase();
        const parsed: Profile = v === 'neutral' ? 'Neutral' : 'Auto';
        model.profile = parsed;
        continue;
      }

      // Hot/dead-pixel suppression (#1106). Case-insensitive parse,
      // mirroring the Rust (`xmp/mod.rs`) and Swift parsers; unknown
      // values are dropped so the field takes its default ('Off').
      if (name === 'papp:HotPixelSuppression') {
        const v = attr.value.toLowerCase();
        const parsed: HotPixelSuppressionMode | undefined =
          v === 'on' ? 'On' : v === 'off' ? 'Off' : undefined;
        if (parsed !== undefined) {
          model.hotPixelSuppression = parsed;
        }
        continue;
      }

      // Highlight recovery (#2214; raw-core spec § 3.3a). Case-insensitive
      // parse mirrors raw-core's `xmp/mod.rs` match arms and the Swift
      // parser; unknown values are dropped so the field takes its default
      // ('ChromaticAdaptation') instead of blocking sidecar load. The
      // variant list is compile-time-exhaustive against the generated union.
      if (name === 'papp:HighlightRecoveryMode') {
        const parsed = matchVariant(HIGHLIGHT_RECOVERY_MODES, attr.value);
        if (parsed !== undefined) {
          model.highlightRecovery = parsed;
        }
        continue;
      }

      // Per-image auto-exposure (#429; TS wiring #2214, web half of #1387).
      // Case-insensitive, unknown values dropped → default ('On'). Mirrors
      // the Swift parser added in PR #2205 and raw-core's `xmp/mod.rs`.
      if (name === 'papp:AutoExposure') {
        const v = attr.value.toLowerCase();
        const parsed: AutoExposureMode | undefined =
          v === 'on' ? 'On' : v === 'off' ? 'Off' : undefined;
        if (parsed !== undefined) {
          model.autoExposure = parsed;
        }
        continue;
      }

      // User white-balance method (#431; TS wiring #2214). Lowercasing
      // covers all spellings raw-core accepts ("cat16" | "Cat16" | "CAT16");
      // unknown values dropped → default ('Cat16').
      if (name === 'papp:WbMethod') {
        const v = attr.value.toLowerCase();
        const parsed: WbMethod | undefined =
          v === 'cat16' ? 'Cat16' : v === 'diagonalrec2020' ? 'DiagonalRec2020' : undefined;
        if (parsed !== undefined) {
          model.wbMethod = parsed;
        }
        continue;
      }

      // Tone-curve application mode (#436; TS wiring #2214). Case-insensitive,
      // unknown values dropped → default ('PerChannel').
      if (name === 'papp:ToneCurveMode') {
        const v = attr.value.toLowerCase();
        const parsed: ToneCurveMode | undefined =
          v === 'perchannel'
            ? 'PerChannel'
            : v === 'ratiopreserving'
              ? 'RatioPreserving'
              : undefined;
        if (parsed !== undefined) {
          model.toneCurveMode = parsed;
        }
        continue;
      }

      // Black & white toggle (#276). Case-insensitive, unknown values
      // dropped → default ('Off'). Mirrors raw-core's `xmp/mod.rs` and the
      // Swift parser. The 8 gray-mixer weights parse via the canonical
      // `ADJUSTMENT_FIELDS` numeric-field path above.
      if (name === 'crs:ConvertToGrayscale') {
        const v = attr.value.toLowerCase();
        const parsed: BlackWhiteMode | undefined =
          v === 'true' || v === '1' ? 'On' : v === 'false' || v === '0' ? 'Off' : undefined;
        if (parsed !== undefined) {
          model.blackWhite = parsed;
        }
        continue;
      }

      // Crop / straighten (#277). Rect fields gated by hasCrop (above);
      // CropAngle is always parsed. HasCrop and CropConstrainToWarp are
      // in KNOWN_ATTRIBUTES so they don't fall into the passthrough bucket.
      if (hasCrop && name === 'crs:CropTop') {
        const n = parseFloat(attr.value);
        if (!Number.isNaN(n)) cropTop = n;
        continue;
      }
      if (hasCrop && name === 'crs:CropLeft') {
        const n = parseFloat(attr.value);
        if (!Number.isNaN(n)) cropLeft = n;
        continue;
      }
      if (hasCrop && name === 'crs:CropBottom') {
        const n = parseFloat(attr.value);
        if (!Number.isNaN(n)) cropBottom = n;
        continue;
      }
      if (hasCrop && name === 'crs:CropRight') {
        const n = parseFloat(attr.value);
        if (!Number.isNaN(n)) cropRight = n;
        continue;
      }
      if (name === 'crs:CropAngle') {
        const n = parseFloat(attr.value);
        if (!Number.isNaN(n)) cropAngle = n;
        continue;
      }
    }

    // Pass 2: apply legacy aliases only where the canonical key didn't
    // already populate the field. DOMParser preserves source order, but
    // this two-pass design makes the sigma-wins contract source-order
    // independent.
    for (const { name, value } of legacyDeferred) {
      const alias = LEGACY_READ_ALIASES_MAP.get(name);
      if (!alias) continue;
      if (canonicallyApplied.has(alias.modelKey)) continue;
      const parsed = alias.parse(value);
      if (!Number.isNaN(parsed)) {
        model[alias.modelKey] = parsed;
      }
    }

    // Post-walk WB load-normalization + Custom-preset inference — see
    // `normalizeParsedWb`'s doc in `xmp-wb-scale.ts` for the full
    // rationale (V2/V3/V4 → V5 joint-pair conversion gated on the
    // attribute-presence record, and the #1892 authored-pair → 'Custom'
    // inference).
    normalizeParsedWb(model, canonicallyApplied, wbScale);

    // Emit `crop` only when any field came through; angle alone is enough
    // (pure straighten). Identity default is applied for absent fields.
    if (
      cropTop !== undefined ||
      cropLeft !== undefined ||
      cropBottom !== undefined ||
      cropRight !== undefined ||
      cropAngle !== undefined
    ) {
      const crop: Crop = {
        top: cropTop ?? 0,
        left: cropLeft ?? 0,
        bottom: cropBottom ?? 1,
        right: cropRight ?? 1,
        angle: cropAngle ?? 0,
      };
      model.crop = crop;
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
    //
    // `dc:subject` is explicitly skipped — the keyword bag round-trips
    // through `parseCulling` + `XmpSerializerService.serialize`'s keywords
    // block. If we left it in `unknownNodes` it would emit twice: once as
    // the canonical block, once via the passthrough pipe. Match by both
    // namespaced and prefix-only forms because DOMParser normalisation
    // varies across browsers.
    const unknownNodes: string[] = [];
    const isManaged = (child: Element): boolean => {
      // dc:subject (keywords) stays excluded as before.
      if (
        (child.namespaceURI === DC_NAMESPACE && child.localName === 'subject') ||
        child.tagName === 'dc:subject'
      ) {
        return true;
      }
      // Batch Metadata managed nested elements (spec 2026-06-26).
      return METADATA_NESTED_ELEMENTS.some(
        (e) =>
          (child.namespaceURI === e.ns && child.localName === e.local) || child.tagName === e.tag,
      );
    };
    for (let i = 0; i < desc.children.length; i++) {
      const child = desc.children[i];
      // Point tone curves (#365) — the only nested elements that carry
      // develop settings. Parsed into the model and re-emitted by the
      // serializer, so they must stay out of the passthrough bucket
      // (double-emit otherwise). `crs:ToneCurvePV2012*` is deliberately not
      // matched here: it is a display-referred curve, a different quantity
      // from these scene-linear ones, and it rides the passthrough pipe
      // untouched.
      const curveKey = toneCurveElementKey(child);
      if (curveKey) {
        model[curveKey] = parseToneCurveElement(child);
        continue;
      }
      if (isManaged(child)) continue;
      unknownNodes.push(child.outerHTML);
    }

    return {
      model,
      passthrough: { unknownAttributes, unknownNodes },
    };
  }
}
