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
import type {
  XmpCulling,
  XmpFlag,
  XmpColorLabel,
  PassthroughBucket,
  XmpMetadata,
} from './xmp.types';
import type { AdjustmentModel, WhiteBalancePreset, Crop } from '../models/adjustment-model';
import type {
  HotPixelSuppressionMode,
  Look,
  Profile,
} from '../generated/adjustment-model.generated';
import { ADJUSTMENT_FIELDS, LEGACY_READ_ALIASES, WB_PRESET_FIELD } from './xmp-fields';
import { resolveWbScaleVersion, inferredWbPresetForAuthoredPair } from './xmp-wb-scale';
import {
  gpsFromXmp,
  altitudeFromXmp,
  copyrightStatusFromMarked,
  METADATA_ATTR_KEYS,
  METADATA_NESTED_ELEMENTS,
} from './xmp-metadata';

/**
 * Precomputed `xmpKey → alias` lookup for `LEGACY_READ_ALIASES`. Used by both
 * passes in `parseAdjustmentModel()` to replace per-attribute `Array.some` /
 * `Array.find` scans with O(1) `Map.get`. Sidecars routinely carry 30+
 * attributes so the constant factor matters even at the current 1-entry
 * alias table.
 */
const LEGACY_READ_ALIASES_MAP = new Map(LEGACY_READ_ALIASES.map((a) => [a.xmpKey, a]));

/** Dublin Core namespace URI — owns `dc:subject` (the IPTC keyword bag). */
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
/** RDF namespace URI — owns `rdf:Bag` and `rdf:li`. */
const RDF_NAMESPACE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

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
   * Returns safe defaults for any field that is absent or unparseable.
   */
  parseCulling(xml: string): XmpCulling {
    const result: XmpCulling = {
      rating: 0,
      flag: 'unflagged',
      colorLabel: null,
      keywords: [],
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

  // ── Metadata block (Batch Metadata, spec 2026-06-26) ────────────────────────

  /**
   * Parse the IPTC/EXIF metadata block. Returns only the fields present;
   * absent fields are left undefined.
   */
  parseMetadata(xml: string): XmpMetadata {
    const result: XmpMetadata = {};
    let desc: Element | null = null;
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (doc.querySelector('parseerror')) return result;
      desc = doc.querySelector('rdf\\:Description') ?? doc.querySelector('Description');
    } catch {
      return result;
    }
    if (!desc) return result;

    // GPS
    const lat = this._attr(desc, ['exif:GPSLatitude']);
    if (lat !== null) {
      const v = gpsFromXmp(lat);
      if (v !== null) result.gpsLatitude = v;
    }
    const lon = this._attr(desc, ['exif:GPSLongitude']);
    if (lon !== null) {
      const v = gpsFromXmp(lon);
      if (v !== null) result.gpsLongitude = v;
    }
    const alt = this._attr(desc, ['exif:GPSAltitude']);
    if (alt !== null) {
      const v = altitudeFromXmp(alt, this._attr(desc, ['exif:GPSAltitudeRef']) ?? '0');
      if (v !== null) result.gpsAltitude = v;
    }

    // Simple string attributes. Empty / whitespace-only values read back as
    // `undefined` (not `""`) so parse matches the "absent field" contract and
    // the serializer's clear-semantics (empty = omitted), and stays consistent
    // with the nested lang-alt/seq text path below.
    const str = (keys: string[]): string | undefined => {
      const v = this._attr(desc!, keys);
      if (v === null) return undefined;
      const trimmed = v.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    result.dateTimeOriginal = str(['exif:DateTimeOriginal']);
    result.timeZone = str(['papp:TimeZone']);
    result.sublocation = str(['Iptc4xmpCore:Location']);
    result.city = str(['photoshop:City']);
    result.state = str(['photoshop:State']);
    result.country = str(['photoshop:Country']);
    result.countryCode = str(['Iptc4xmpCore:CountryCode']);
    result.headline = str(['photoshop:Headline']);
    result.instructions = str(['photoshop:Instructions']);
    result.creatorJobTitle = str(['photoshop:AuthorsPosition']);
    result.credit = str(['photoshop:Credit']);
    result.source = str(['photoshop:Source']);

    const status = copyrightStatusFromMarked(this._attr(desc, ['xmpRights:Marked']));
    if (status !== null) result.copyrightStatus = status;

    // Nested lang-alt / seq elements → first rdf:li text content.
    const DC = 'http://purl.org/dc/elements/1.1/';
    result.title = this._nestedText(desc, DC, 'title', 'dc:title');
    result.caption = this._nestedText(desc, DC, 'description', 'dc:description');
    result.creator = this._nestedText(desc, DC, 'creator', 'dc:creator');
    result.copyrightNotice = this._nestedText(desc, DC, 'rights', 'dc:rights');
    result.usageTerms = this._nestedText(
      desc,
      'http://ns.adobe.com/xap/1.0/rights/',
      'UsageTerms',
      'xmpRights:UsageTerms',
    );

    // Strip undefined keys so an empty edit yields {} (byte-stable round-trip).
    for (const k of Object.keys(result) as (keyof XmpMetadata)[]) {
      if (result[k] === undefined) delete result[k];
    }
    return result;
  }

  /** First `rdf:li` text content of a nested lang-alt/seq element, or undefined. */
  private _nestedText(desc: Element, ns: string, local: string, qname: string): string | undefined {
    const elsNS = desc.getElementsByTagNameNS(ns, local);
    const el = elsNS.length > 0 ? elsNS[0] : desc.getElementsByTagName(qname)[0];
    if (!el) return undefined;
    const liNS = el.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li');
    const li = liNS.length > 0 ? liNS[0] : el.getElementsByTagName('rdf:li')[0];
    const text = (li?.textContent ?? '').trim();
    return text.length > 0 ? text : undefined;
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

    // WB scale versioning (#1780/#1875) — resolution rule + V2→V3
    // normalization rationale live in `xmp-wb-scale.ts`.
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

    // V2 → V3 tint negation (#1875) — after the walk so it applies to the
    // final parsed value. Only an explicitly authored crs:Tint negates;
    // preset-resolved tints were never expressed in the inverted scale.
    // (The `model.tint` guard covers malformed values the walk dropped.)
    if (wbScale.negateAuthoredTint && model.tint !== undefined) {
      model.tint = -model.tint;
    }

    // Authored WB with no crs:WhiteBalance is a Custom WB (#1892) — see
    // `inferredWbPresetForAuthoredPair`'s doc for the full rationale.
    const inferred = inferredWbPresetForAuthoredPair(model.whiteBalancePreset, canonicallyApplied);
    if (inferred) model.whiteBalancePreset = inferred;

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
      if (isManaged(child)) continue;
      unknownNodes.push(child.outerHTML);
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
