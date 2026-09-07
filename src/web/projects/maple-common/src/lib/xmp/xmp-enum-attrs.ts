// xmp-enum-attrs.ts — the single-attribute enum fields of
// `XmpParserService.parseAdjustmentModel` (#1840, complexity hotspot):
// `papp:FilmLook`, `papp:HotPixelSuppression`, `crs:LensProfileEnable`,
// `papp:HighlightRecoveryMode`, `papp:AutoExposure`, `papp:WbMethod`,
// `papp:ToneCurveMode`, `crs:ConvertToGrayscale`. Each is independent of
// every other attribute in the document (unlike Look/Profile in
// `xmp-look-profile.ts`, or the crop group in `xmp-crop.ts`), so they are
// expressed as one name → parser lookup instead of a chain of `if`s.

import type { AdjustmentModel } from '../models/adjustment-model';
import type {
  AutoExposureMode,
  BlackWhiteMode,
  HighlightRecoveryMode,
  HotPixelSuppressionMode,
  LensProfileEnable,
  ToneCurveMode,
  WbMethod,
  WbSource,
} from '../generated/adjustment-model.generated';

/**
 * Wire variants for `papp:HighlightRecoveryMode` (#2214). The list must stay
 * exhaustive against the generated union — the `satisfies` record makes a
 * missing variant a compile error when codegen adds one, so this parser
 * can't silently lag raw-core's `xmp/mod.rs` match arms.
 */
/** `papp:WbSource` vocabulary (#2434) — matched case-insensitively like the other papp: enums. */
const WB_SOURCES: readonly WbSource[] = ['AsShot', 'Auto', 'Preset', 'Sampled', 'Manual'];

const HIGHLIGHT_RECOVERY_MODES = Object.keys({
  Off: true,
  Blend: true,
  Luminance: true,
  ChromaticAdaptation: true,
  OklabChromaReduction: true,
} satisfies Record<HighlightRecoveryMode, true>) as readonly HighlightRecoveryMode[];

/** Case-insensitive wire → canonical variant match, or undefined if unknown. */
function matchVariant<T extends string>(variants: readonly T[], raw: string): T | undefined {
  const lower = raw.toLowerCase();
  return variants.find((v) => v.toLowerCase() === lower);
}

type EnumAttributeParser = (rawValue: string) => Partial<AdjustmentModel> | undefined;

const ENUM_ATTRIBUTE_PARSERS: Record<string, EnumAttributeParser> = {
  // Film emulation (epic #2683). `filmLook` is a free-form film-catalog id,
  // not a fixed enum — parsed VERBATIM (no case-folding, no known-variant
  // allowlist) so a sidecar referencing a look from a newer catalog build
  // still round-trips instead of being dropped to the '' default. An empty
  // attribute is treated the same as absent.
  'papp:FilmLook': (v) => (v.length > 0 ? { filmLook: v } : undefined),
  // Preserve future reference versions; the core reports unsupported versions
  // at render time instead of silently changing the selected correction.
  'papp:LensProfile': (v) => (v.length > 0 ? { lensProfile: v } : undefined),

  // Hot/dead-pixel suppression (#1106). Case-insensitive parse, mirroring
  // the Rust (`xmp/mod.rs`) and Swift parsers; unknown values are dropped so
  // the field takes its default ('Off').
  'papp:HotPixelSuppression': (v) => {
    const lower = v.toLowerCase();
    const parsed: HotPixelSuppressionMode | undefined =
      lower === 'on' ? 'On' : lower === 'off' ? 'Off' : undefined;
    return parsed !== undefined ? { hotPixelSuppression: parsed } : undefined;
  },

  // DNG lens corrections master switch (#376). ACR writes "1"/"0"; the
  // True/False spelling other XMP writers use for boolean `crs:` markers is
  // accepted too, mirroring the Rust and Swift parsers. Unknown values are
  // dropped so the field takes its default ('On') rather than blocking
  // sidecar load.
  'crs:LensProfileEnable': (v) => {
    const lower = v.toLowerCase();
    const parsed: LensProfileEnable | undefined =
      lower === '1' || lower === 'true' || lower === 'on'
        ? 'On'
        : lower === '0' || lower === 'false' || lower === 'off'
          ? 'Off'
          : undefined;
    return parsed !== undefined ? { lensProfileEnable: parsed } : undefined;
  },

  // Highlight recovery (#2214; raw-core spec § 3.3a). Case-insensitive parse
  // mirrors raw-core's `xmp/mod.rs` match arms and the Swift parser; unknown
  // values are dropped so the field takes its default
  // ('ChromaticAdaptation') instead of blocking sidecar load.
  'papp:HighlightRecoveryMode': (v) => {
    const parsed = matchVariant(HIGHLIGHT_RECOVERY_MODES, v);
    return parsed !== undefined ? { highlightRecovery: parsed } : undefined;
  },

  // Per-image auto-exposure (#429; TS wiring #2214, web half of #1387).
  // Case-insensitive, unknown values dropped → default ('On'). Mirrors the
  // Swift parser added in PR #2205 and raw-core's `xmp/mod.rs`.
  'papp:AutoExposure': (v) => {
    const lower = v.toLowerCase();
    const parsed: AutoExposureMode | undefined =
      lower === 'on' ? 'On' : lower === 'off' ? 'Off' : undefined;
    return parsed !== undefined ? { autoExposure: parsed } : undefined;
  },

  // User white-balance method (#431; TS wiring #2214). Lowercasing covers
  // all spellings raw-core accepts ("cat16" | "Cat16" | "CAT16"); unknown
  // values dropped → default ('Cat16').
  'papp:WbMethod': (v) => {
    const lower = v.toLowerCase();
    const parsed: WbMethod | undefined =
      lower === 'cat16' ? 'Cat16' : lower === 'diagonalrec2020' ? 'DiagonalRec2020' : undefined;
    return parsed !== undefined ? { wbMethod: parsed } : undefined;
  },

  // Tone-curve application mode (#436; TS wiring #2214). Case-insensitive,
  // unknown values dropped → default ('PerChannel').
  'papp:WbSource': (v) => {
    const parsed = WB_SOURCES.find((s) => s.toLowerCase() === v.toLowerCase());
    return parsed !== undefined ? { wbSource: parsed } : undefined;
  },
  'papp:ToneCurveMode': (v) => {
    const lower = v.toLowerCase();
    const parsed: ToneCurveMode | undefined =
      lower === 'perchannel'
        ? 'PerChannel'
        : lower === 'ratiopreserving'
          ? 'RatioPreserving'
          : undefined;
    return parsed !== undefined ? { toneCurveMode: parsed } : undefined;
  },

  // Black & white toggle (#276). Case-insensitive, unknown values dropped →
  // default ('Off'). Mirrors raw-core's `xmp/mod.rs` and the Swift parser.
  // The 8 gray-mixer weights parse via the canonical `ADJUSTMENT_FIELDS`
  // numeric-field path in the caller.
  'crs:ConvertToGrayscale': (v) => {
    const lower = v.toLowerCase();
    const parsed: BlackWhiteMode | undefined =
      lower === 'true' || lower === '1'
        ? 'On'
        : lower === 'false' || lower === '0'
          ? 'Off'
          : undefined;
    return parsed !== undefined ? { blackWhite: parsed } : undefined;
  },
};

/**
 * Applies `name`/`rawValue` to `model` if it's one of the single-attribute
 * enum fields above. Returns whether `name` was recognized (regardless of
 * whether the value parsed) — the caller uses this to decide whether to
 * keep matching the attribute against other field groups.
 */
export function applyEnumAttribute(
  model: Partial<AdjustmentModel>,
  name: string,
  rawValue: string,
): boolean {
  const parser = ENUM_ATTRIBUTE_PARSERS[name];
  if (!parser) return false;
  const patch = parser(rawValue);
  if (patch) Object.assign(model, patch);
  return true;
}
