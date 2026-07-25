// AdjustmentModel.swift — Swift mirror of raw_core::xmp::AdjustmentModel.
//
// Fields, defaults, and ranges match spec § 01 and the Rust source in
// src/raw-pipeline/raw-core/src/xmp.rs exactly.
//
// This file owns the value types only:
//   • `HighlightRecoveryMode`, `Look`, `Profile` — pipeline-shaping enums
//   • `AdjustmentModel`                          — per-image develop knobs
//
// `CullingState`, `CullFlag`, and `ColorLabel` (culling + IPTC keywords)
// moved to `CullingState.swift` in #1656, when the new `colorLabel` field
// would have pushed this file past `CONTRIBUTING.md`'s 600-line hard
// budget.
//
// The nested value types the model carries live in their own files:
// `Crop.swift` and `ToneCurve.swift` (both split off in #366, when the
// point-curve fields pushed this file back against the budget).
//
// The XMP read/write surface lives next door in `XMPSerialization.swift`
// (`XMPParser` + `XMPSerializer`); the split happened during #632 once the
// extra `dc:subject` handling pushed this file past that same budget.

import Foundation

// MARK: - HighlightRecoveryMode

public enum HighlightRecoveryMode: String, Codable, Sendable, Hashable {
    case off                  = "Off"
    case blend                = "Blend"
    case luminance            = "Luminance"
    /// Path C — `AsShotNeutral`-aware chromatic-adaptation highlight
    /// reconstruction (ticket #325). `blend` and `luminance` are legacy
    /// variants kept for back-compat: raw-core silently upgrades them at
    /// apply time.
    case chromaticAdaptation  = "ChromaticAdaptation"
    /// Ticket #471 — post-DCP Oklab chroma reduction. Opt-in. Runs in
    /// scene-linear Rec.2020 D65 (where Oklab is well-defined) and reduces
    /// Oklab chroma at clipped pixels while preserving hue.
    case oklabChromaReduction = "OklabChromaReduction"
}

// MARK: - Look

/// DisplayLookCurve (ticket #371; **retired in #443** — Wave-3 closing
/// step of #416). Mirrors `raw_core::types::adjustment::Look`.
///
/// Both `.default` and `.neutral` are now identical no-ops at the
/// pipeline level. The enum is kept so `papp:Look` in pre-#443 sidecars
/// round-trips cleanly; the serializer still skips the attribute when the
/// model holds the canonical `.default` value. Apple has never applied
/// the LUT (CoreImage owns the view transform), so this change is a no-op
/// on the Apple render path.
public enum Look: String, Codable, Sendable, Hashable {
    case neutral = "Neutral"
    case `default` = "Default"

    /// C-ABI `look_mode` byte the Rust `Look::from(u8)` maps back (0 =
    /// Neutral, anything else = Default). Threaded into
    /// `MapleAdjustmentParams.look_mode` so the FFI scene-linear chain
    /// reconstructs the user's selection instead of a hard-coded literal.
    public var lookMode: UInt8 {
        switch self {
        case .neutral: return 0
        case .default: return 1
        }
    }
}

// MARK: - Profile

/// Render-shaping profile (Auto Profile Phase 1, ticket #536). Mirrors
/// `raw_core::types::adjustment::Profile`. Replaces the retired
/// `papp:Look` attribute on the write path; legacy `papp:Look` values
/// still migrate into `Profile` on read (see `XMPParser`).
///
/// Default is `.auto` — new sidecars omit `papp:Profile` and existing
/// sidecars without the attribute land on `.auto`.
public enum Profile: String, Codable, Sendable, Hashable, CaseIterable {
    case auto     = "Auto"
    case neutral  = "Neutral"
    case acrMatch = "AcrMatch"
}

// MARK: - HotPixelSuppressionMode

/// Hot/dead-pixel suppression (#1106, tone/zoom design § 10.6). Mirrors
/// `raw_core::types::adjustment::HotPixelSuppressionMode`: pre-demosaic
/// same-color-neighbor outlier replacement inside the Rust decode product.
/// `off` (default) is a bit-identical decode skip.
public enum HotPixelSuppressionMode: String, Codable, Sendable, Hashable, CaseIterable {
    case off = "Off"
    case on  = "On"
}

// MARK: - AutoExposureMode

/// Auto-exposure mode (raw-core ticket #429; mirrored into Swift by #1387).
/// Mirrors `raw_core::types::adjustment::AutoExposureMode` — gates the
/// decode-time `auto_exposure` stage, a scalar mid-gray anchor gain baked
/// into the Rust decode product. No Apple-Metal live re-apply, so the field
/// rides through `stripAppleGPUStages` untouched (like `highlightRecovery`).
///
/// `.on` (default) matches raw-core's parse default. `Profile.auto`'s
/// decode forces this Off internally whenever an Auto Profile curve will
/// fit; `Profile.neutral`/`.acrMatch` apply it as written. AUTO
/// (`EditorState.applyAuto`) sets it to `.off` alongside `exposure` on
/// every profile since its recommendation is measured against an AE-Off
/// probe — skipping that on Neutral would double-count the anchor gain.
public enum AutoExposureMode: String, Codable, Sendable, Hashable, CaseIterable {
    case on  = "On"
    case off = "Off"
}

// MARK: - AdjustmentModel

/// Per-image editing knobs. Mirrors `raw_core::xmp::AdjustmentModel`.
/// All values are stored at full float64 precision (Lightroom uses float32
/// on-wire; we widen to Double here for Swift arithmetic convenience and
/// narrow before the FFI call path).
public struct AdjustmentModel: Codable, Sendable, Equatable, Hashable {
    // White balance
    public var temperature: Double      // 2000..12000, default 6500
    public var tint: Double             // -150..150 (ACR's crs:Tint span, #1870), default 0
    /// WB slider-scale version of this model's temperature/tint
    /// (#1780/#1875/#1893/#1894). `1` = pre-#1756 scale (post-DCP CAT16,
    /// 6500 K identity) — raw-core converts on use; `5` = the Robertson
    /// (DNG SDK `dng_temperature`) mapping ACR's own slider displays
    /// natively (current). `2`/`3`/`4` (the legacy Hernández-Andrés
    /// daylight-locus scales — `2`/`3` at the 1e-4-magnitude, with `2`'s
    /// tint axis also inverted vs ACR; `4` at ACR's kTintScale magnitude
    /// but still the legacy locus, #1893) never survive a parse: the
    /// loader re-expresses the authored `(temperature, tint)` PAIR jointly
    /// through physical chromaticity (`WbDngTemperature.authoredPairToV5`)
    /// and normalizes the model to `5`. Parsed from `papp:WbScaleVersion`
    /// (absent stamp on a Maple-authored sidecar means `1`; non-Maple
    /// sidecars are `5`), re-stamped on write as {1, 5}. Fresh models
    /// author in the current scale.
    public var wbScaleVersion: Int      // 1 | 5, default 5

    // Basic tone
    public var exposure: Double         // -4..+4 EV, default 0
    /// Brightness — scene-linear midtone-band gain (#1102, tone/zoom design
    /// § 4.1). Runs inside `scene_tone_controls` after exposure, before
    /// highlights/shadows/whites/blacks. XMP key `papp:Brightness` (NOT the
    /// ACR PV2010 `crs:Brightness`, which has different semantics).
    public var brightness: Double       // -100..100, default 0
    public var contrast: Double         // -100..100, default 0
    public var highlights: Double       // -100..100, default 0
    public var shadows: Double          // -100..100, default 0
    public var whites: Double           // -100..100, default 0
    public var blacks: Double           // -100..100, default 0

    // Parametric tone curve — PV2012-style four-region sliders (ticket #273).
    // Synthesises a piecewise-cubic over the canonical region split points
    // (¼, ½, ¾) and applies post-`scene_tone_controls`, pre-`vibrance` in
    // the Rust core. Identity at all-zero. The per-channel POINT curves
    // (`crs:ToneCurvePV2012*`) are the `toneCurve*` fields further down;
    // their sidecar round-trip lands in #365.
    public var parametricHighlights: Double  // -100..100, default 0
    public var parametricLights: Double      // -100..100, default 0
    public var parametricDarks: Double       // -100..100, default 0
    public var parametricShadows: Double     // -100..100, default 0

    // Presence
    public var vibrance: Double         // -100..100, default 0
    public var saturation: Double       // -100..100, default 0
    public var clarity: Double          // -100..100, default 0
    public var texture: Double          // -100..100, default 0
    public var dehaze: Double           // -100..100, default 0

    // Detail — sharpening
    //
    // Defaults mirror the reference renderer / Lightroom's import baseline
    // (Sharpness=40, Radius=1.0, Detail=25, EdgeMasking=0) so first-open of
    // a sidecar-less RAW looks as sharp as the reference renderer's
    // default-import, not soft. Aligned with the canonical raw-core defaults
    // per #326 — Apple no longer carries a sharpening divergence (was
    // sharpenAmount=45).
    public var sharpenAmount: Double    // 0..150, default 40 (reference import)
    public var sharpenRadius: Double    // 0.5..3.0, default 1.0 (reference import)
    public var sharpenDetail: Double    // 0..100, default 25
    public var sharpenMasking: Double   // 0..100, default 0

    // Detail — capture sharpening (Maple-proprietary Richardson-Lucy
    // deconvolution; distinct from the reference renderer's unsharp-mask
    // sliders above).
    // Defaults to 0 (stage skipped) so first-open matches pre-#271 behaviour
    // bit-identically. Per-camera defaults are a follow-up calibration ticket.
    public var captureSharpeningAmount: Double  // 0..100, default 0
    /// Gaussian PSF sigma in pixels (#456). Renamed from
    /// `captureSharpeningRadius` after PR #452 swapped the integer-radius
    /// tripled-box-blur for a true Gaussian. The XMP key
    /// `papp:CaptureSharpeningSigma` is the canonical write key; the legacy
    /// `papp:CaptureSharpeningRadius` is still accepted on read.
    public var captureSharpeningSigma: Double   // 0.5..2.0, default 1.0

    // Detail — noise reduction
    public var nrLuminance: Double      // 0..100, default 0
    public var nrColor: Double          // 0..100, default 25

    // S5 effects fields (ticket #643) — identity-stub scalars added so the
    // editor's tool-pill row can wire vignette / grain / split-tone to a
    // canonical field. No pipeline stage consumes these yet; defaults keep
    // first-open output bit-identical to the pre-#643 pipeline. Follow-up
    // tickets track the actual pipeline math.

    // Vignette (§ 3.12). Primary drag-bar field for the Vignette tool is
    // `vignetteAmount`. `vignetteFeather` is carried for XMP round-trip
    // and a future dedicated UI affordance.
    public var vignetteAmount: Double        // -100..100, default 0
    public var vignetteFeather: Double       // 0..100, default 50

    // Grain (§ 3.13). Primary drag-bar field for the Grain tool is
    // `grainAmount`; size + roughness are carried for XMP round-trip.
    public var grainAmount: Double           // 0..100, default 0
    public var grainSize: Double             // 0..100, default 25
    public var grainRoughness: Double        // 0..100, default 50

    // Split toning (§ 3.14). Primary drag-bar field for the Split Tone tool
    // is `splitToneBalance` (the shadow/highlight blend point); the four
    // hue/sat scalars are carried for XMP round-trip and a future dedicated
    // hue/sat wheel. Hue is in degrees; saturation is `[0, 100]`.
    public var splitToneShadowHue: Double          // 0..360, default 0
    public var splitToneShadowSaturation: Double   // 0..100, default 0
    public var splitToneHighlightHue: Double       // 0..360, default 0
    public var splitToneHighlightSaturation: Double // 0..100, default 0
    public var splitToneBalance: Double            // -100..100, default 0

    // HSL per-band adjustments (#1112, tone/zoom design spec § 10.4).
    // Scene-linear Oklab, normalized raised-cosine partition of unity.
    // All three rows (Hue / Saturation / Luminance) × 8 ACR-aligned bands.
    // Range -100..+100, default 0. XMP keys: crs:HueAdjustmentRed, etc.
    // Names match the generated schema (hue_adjustment_red → hueAdjustmentRed).
    public var hueAdjustmentRed: Double         // -100..100, default 0
    public var hueAdjustmentOrange: Double      // -100..100, default 0
    public var hueAdjustmentYellow: Double      // -100..100, default 0
    public var hueAdjustmentGreen: Double       // -100..100, default 0
    public var hueAdjustmentAqua: Double        // -100..100, default 0
    public var hueAdjustmentBlue: Double        // -100..100, default 0
    public var hueAdjustmentPurple: Double      // -100..100, default 0
    public var hueAdjustmentMagenta: Double     // -100..100, default 0
    public var saturationAdjustmentRed: Double      // -100..100, default 0
    public var saturationAdjustmentOrange: Double   // -100..100, default 0
    public var saturationAdjustmentYellow: Double   // -100..100, default 0
    public var saturationAdjustmentGreen: Double    // -100..100, default 0
    public var saturationAdjustmentAqua: Double     // -100..100, default 0
    public var saturationAdjustmentBlue: Double     // -100..100, default 0
    public var saturationAdjustmentPurple: Double   // -100..100, default 0
    public var saturationAdjustmentMagenta: Double  // -100..100, default 0
    public var luminanceAdjustmentRed: Double       // -100..100, default 0
    public var luminanceAdjustmentOrange: Double    // -100..100, default 0
    public var luminanceAdjustmentYellow: Double    // -100..100, default 0
    public var luminanceAdjustmentGreen: Double     // -100..100, default 0
    public var luminanceAdjustmentAqua: Double      // -100..100, default 0
    public var luminanceAdjustmentBlue: Double      // -100..100, default 0
    public var luminanceAdjustmentPurple: Double    // -100..100, default 0
    public var luminanceAdjustmentMagenta: Double   // -100..100, default 0

    // Highlight recovery (Maple-proprietary)
    public var highlightRecovery: HighlightRecoveryMode

    /// Auto-exposure mode (#1387). Decode-time scalar mid-gray anchor gain,
    /// baked into the Rust decode product like `highlightRecovery` above —
    /// no Apple-Metal live re-apply, so `stripAppleGPUStages` keeps it.
    /// Defaults to `.on` (raw-core's parse default). XMP key
    /// `papp:AutoExposure`; `.on` (default) omits the attribute on write.
    public var autoExposure: AutoExposureMode

    // DisplayLookCurve (Maple-proprietary, ticket #371). Defaults to
    // `.default` — new users get the empirical Look.
    public var look: Look

    // Render-shaping profile (Auto Profile Phase 1, ticket #536). Defaults
    // to `.auto`. Replaces the retired `papp:Look` attribute on the write
    // path; the XMP parser migrates legacy `papp:Look` values into this
    // field when `papp:Profile` is absent.
    public var profile: Profile

    // Per-channel point curves (#273 slice 1; schema/codegen in #366).
    // Each is a `ToneCurve` of `(x, y)` control points in `[0, 1]`
    // authoring space, identity when empty — so a default model renders
    // bit-identically to the pre-tone-curve pipeline. `toneCurveLuma`
    // applies channels-uniformly via the Rec.2020 luma weights; the R/G/B
    // curves apply per the core's tone-curve mode. Sidecar round-trip is
    // #365 and the curve editor is #367; the fields land here first so
    // both have a canonical Swift home. Field order mirrors
    // `raw_core::types::AdjustmentModel`.
    public var toneCurveLuma: ToneCurve   // default .identity (empty)
    public var toneCurveRed: ToneCurve    // default .identity (empty)
    public var toneCurveGreen: ToneCurve  // default .identity (empty)
    public var toneCurveBlue: ToneCurve   // default .identity (empty)

    /// Decode-time chroma pre-filter (#1104, tone/zoom design § 3.1).
    /// Luma-guided sparse cross-bilateral on opponent chroma, baked into
    /// the Rust decode product (post-DCP, pre auto-exposure) — there is
    /// no per-tick Apple chain equivalent, so `stripAppleGPUStages` keeps
    /// it and the decoded-image cache key (the baked model, #950) picks
    /// it up automatically: changing it re-decodes. XMP key
    /// `papp:ChromaPrefilter`; 0 (default) = bit-identical stage skip.
    public var chromaPrefilter: Double  // 0..100, default 0

    /// Hot/dead-pixel suppression (#1106, tone/zoom design § 10.6).
    /// Pre-demosaic, baked into the Rust decode product like
    /// `chromaPrefilter` — kept by `stripAppleGPUStages`, so the #950
    /// baked-model decode-cache key carries it automatically. XMP key
    /// `papp:HotPixelSuppression`; `.off` (default) = bit-identical skip.
    public var hotPixelSuppression: HotPixelSuppressionMode

    /// BM3D deep denoise (#1105, tone/zoom design § 3.2). Input-referred,
    /// baked into the Rust decode product immediately after
    /// `chromaPrefilter` — same KEPT/strip + #950 baked-model cache-key
    /// story (changing it re-decodes; the cached decoded buffer is what
    /// amortises the seconds-scale runtime). XMP key `papp:DeepDenoise`;
    /// 0 (default) = bit-identical stage skip.
    public var deepDenoise: Double  // 0..100, default 0

    /// Geometry — crop rect (normalised to display-oriented dimensions) plus
    /// straighten angle. Default is `Crop.identity` (full frame, 0°). When
    /// identity, the crop stage is skipped and the XMP serializer omits the
    /// whole `crs:Crop*` group. See `Crop` and spec § 3.12.
    public var crop: Crop          // default .identity

    public init(
        temperature: Double = 6500,
        tint: Double = 0,
        wbScaleVersion: Int = 5,
        exposure: Double = 0,
        brightness: Double = 0,
        contrast: Double = 0,
        highlights: Double = 0,
        shadows: Double = 0,
        whites: Double = 0,
        blacks: Double = 0,
        parametricHighlights: Double = 0,
        parametricLights: Double = 0,
        parametricDarks: Double = 0,
        parametricShadows: Double = 0,
        vibrance: Double = 0,
        saturation: Double = 0,
        clarity: Double = 0,
        texture: Double = 0,
        dehaze: Double = 0,
        sharpenAmount: Double = 40,
        sharpenRadius: Double = 1.0,
        sharpenDetail: Double = 25,
        sharpenMasking: Double = 0,
        captureSharpeningAmount: Double = 0,
        captureSharpeningSigma: Double = 1.0,
        nrLuminance: Double = 0,
        nrColor: Double = 25,
        vignetteAmount: Double = 0,
        vignetteFeather: Double = 50,
        grainAmount: Double = 0,
        grainSize: Double = 25,
        grainRoughness: Double = 50,
        splitToneShadowHue: Double = 0,
        splitToneShadowSaturation: Double = 0,
        splitToneHighlightHue: Double = 0,
        splitToneHighlightSaturation: Double = 0,
        splitToneBalance: Double = 0,
        hueAdjustmentRed: Double = 0,
        hueAdjustmentOrange: Double = 0,
        hueAdjustmentYellow: Double = 0,
        hueAdjustmentGreen: Double = 0,
        hueAdjustmentAqua: Double = 0,
        hueAdjustmentBlue: Double = 0,
        hueAdjustmentPurple: Double = 0,
        hueAdjustmentMagenta: Double = 0,
        saturationAdjustmentRed: Double = 0,
        saturationAdjustmentOrange: Double = 0,
        saturationAdjustmentYellow: Double = 0,
        saturationAdjustmentGreen: Double = 0,
        saturationAdjustmentAqua: Double = 0,
        saturationAdjustmentBlue: Double = 0,
        saturationAdjustmentPurple: Double = 0,
        saturationAdjustmentMagenta: Double = 0,
        luminanceAdjustmentRed: Double = 0,
        luminanceAdjustmentOrange: Double = 0,
        luminanceAdjustmentYellow: Double = 0,
        luminanceAdjustmentGreen: Double = 0,
        luminanceAdjustmentAqua: Double = 0,
        luminanceAdjustmentBlue: Double = 0,
        luminanceAdjustmentPurple: Double = 0,
        luminanceAdjustmentMagenta: Double = 0,
        highlightRecovery: HighlightRecoveryMode = .chromaticAdaptation,
        autoExposure: AutoExposureMode = .on,
        look: Look = .default,
        profile: Profile = .auto,
        toneCurveLuma: ToneCurve = .identity,
        toneCurveRed: ToneCurve = .identity,
        toneCurveGreen: ToneCurve = .identity,
        toneCurveBlue: ToneCurve = .identity,
        chromaPrefilter: Double = 0,
        hotPixelSuppression: HotPixelSuppressionMode = .off,
        deepDenoise: Double = 0,
        crop: Crop = .identity
    ) {
        self.temperature = temperature
        self.tint = tint
        self.wbScaleVersion = wbScaleVersion
        self.exposure = exposure
        self.brightness = brightness
        self.contrast = contrast
        self.highlights = highlights
        self.shadows = shadows
        self.whites = whites
        self.blacks = blacks
        self.parametricHighlights = parametricHighlights
        self.parametricLights = parametricLights
        self.parametricDarks = parametricDarks
        self.parametricShadows = parametricShadows
        self.vibrance = vibrance
        self.saturation = saturation
        self.clarity = clarity
        self.texture = texture
        self.dehaze = dehaze
        self.sharpenAmount = sharpenAmount
        self.sharpenRadius = sharpenRadius
        self.sharpenDetail = sharpenDetail
        self.sharpenMasking = sharpenMasking
        self.captureSharpeningAmount = captureSharpeningAmount
        self.captureSharpeningSigma = captureSharpeningSigma
        self.nrLuminance = nrLuminance
        self.nrColor = nrColor
        self.vignetteAmount = vignetteAmount
        self.vignetteFeather = vignetteFeather
        self.grainAmount = grainAmount
        self.grainSize = grainSize
        self.grainRoughness = grainRoughness
        self.splitToneShadowHue = splitToneShadowHue
        self.splitToneShadowSaturation = splitToneShadowSaturation
        self.splitToneHighlightHue = splitToneHighlightHue
        self.splitToneHighlightSaturation = splitToneHighlightSaturation
        self.splitToneBalance = splitToneBalance
        self.hueAdjustmentRed = hueAdjustmentRed
        self.hueAdjustmentOrange = hueAdjustmentOrange
        self.hueAdjustmentYellow = hueAdjustmentYellow
        self.hueAdjustmentGreen = hueAdjustmentGreen
        self.hueAdjustmentAqua = hueAdjustmentAqua
        self.hueAdjustmentBlue = hueAdjustmentBlue
        self.hueAdjustmentPurple = hueAdjustmentPurple
        self.hueAdjustmentMagenta = hueAdjustmentMagenta
        self.saturationAdjustmentRed = saturationAdjustmentRed
        self.saturationAdjustmentOrange = saturationAdjustmentOrange
        self.saturationAdjustmentYellow = saturationAdjustmentYellow
        self.saturationAdjustmentGreen = saturationAdjustmentGreen
        self.saturationAdjustmentAqua = saturationAdjustmentAqua
        self.saturationAdjustmentBlue = saturationAdjustmentBlue
        self.saturationAdjustmentPurple = saturationAdjustmentPurple
        self.saturationAdjustmentMagenta = saturationAdjustmentMagenta
        self.luminanceAdjustmentRed = luminanceAdjustmentRed
        self.luminanceAdjustmentOrange = luminanceAdjustmentOrange
        self.luminanceAdjustmentYellow = luminanceAdjustmentYellow
        self.luminanceAdjustmentGreen = luminanceAdjustmentGreen
        self.luminanceAdjustmentAqua = luminanceAdjustmentAqua
        self.luminanceAdjustmentBlue = luminanceAdjustmentBlue
        self.luminanceAdjustmentPurple = luminanceAdjustmentPurple
        self.luminanceAdjustmentMagenta = luminanceAdjustmentMagenta
        self.highlightRecovery = highlightRecovery
        self.autoExposure = autoExposure
        self.look = look
        self.profile = profile
        self.toneCurveLuma = toneCurveLuma
        self.toneCurveRed = toneCurveRed
        self.toneCurveGreen = toneCurveGreen
        self.toneCurveBlue = toneCurveBlue
        self.chromaPrefilter = chromaPrefilter
        self.hotPixelSuppression = hotPixelSuppression
        self.deepDenoise = deepDenoise
        self.crop = crop
    }

    public static let `default` = AdjustmentModel()

    /// True when this model carries user adjustments that change the
    /// rendered pixels, judged with the white-balance fields excluded.
    ///
    /// WB must be excluded because the Apple model carries no WB-method
    /// field (see `GpuLiveParams`): on first open the editor seeds
    /// `temperature`/`tint` with the image's as-shot values, so a
    /// rating-only or flag-only sidecar save records non-default WB numbers
    /// that do NOT represent an edit. Comparing against a baseline that
    /// copies the WB fields treats those sidecars as visually unedited —
    /// the common culling case — at the cost of also treating a WB-only
    /// edit as unedited. Callers that gate derived-image generation on this
    /// (the `.maple/previews` display tier in `ThumbnailLoader`) accept
    /// that trade-off: a WB-only edit made in the local editor still gets a
    /// correct display preview from the editor-exit render refresh; only a
    /// WB-only edit arriving externally (synced sidecar, never rendered on
    /// this device) slips through.
    public var isVisuallyEditedBeyondWhiteBalance: Bool {
        let baseline = AdjustmentModel(
            temperature: temperature,
            tint: tint,
            wbScaleVersion: wbScaleVersion
        )
        return self != baseline
    }
}
