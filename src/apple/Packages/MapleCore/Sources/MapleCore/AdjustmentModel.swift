// AdjustmentModel.swift — Swift mirror of raw_core::xmp::AdjustmentModel.
//
// Fields, defaults, and ranges match spec § 01 and the Rust source in
// src/raw-pipeline/raw-core/src/xmp.rs exactly.
//
// This file owns `AdjustmentModel` itself — the per-image develop knobs and
// their defaults. There is no hand-written `init` any more (#2320): every
// stored property carries its own default inline, so Swift's synthesised
// memberwise initializer — which supports the same partial-keyword calls
// (`AdjustmentModel(exposure: 1.2)`) the old hand-written one did — covers
// every construction site with none of the line cost of restating 100+
// parameters and 100+ `self.x = x` assignments a second time. (A prior
// version of this comment warned that a hand-written `init` "cannot be
// lifted into an extension" because the compiler re-synthesises a colliding
// memberwise init the moment the explicit one leaves the struct body — true,
// and still true if you want an explicit `init` at all, but deleting the
// explicit `init` in favor of the free one sidesteps the collision
// entirely.) Splits of this file now move stored properties' *types* out —
// nested value types or enums — not the initializer.
//
// The pipeline-shaping enums it carries as fields (`HighlightRecoveryMode`,
// `Look`, `Profile`, `HotPixelSuppressionMode`, `LensProfileEnable`,
// `AutoExposureMode`) moved to `AdjustmentModel+Enums.swift` in #376, when
// the lens-correction fields pushed this file past the budget again.
//
// `CullingState`, `CullFlag`, and `ColorLabel` (culling + IPTC keywords)
// moved to `CullingState.swift` in #1656, when the new `colorLabel` field
// would have pushed this file past `CONTRIBUTING.md`'s 600-line hard
// budget.
//
// `BlackWhiteMode` lives in `AdjustmentModel+BlackWhite.swift` for the same
// budget reason (#276).
//
// The nested value types the model carries live in their own files:
// `Crop.swift` and `ToneCurve.swift` (both split off in #366, when the
// point-curve fields pushed this file back against the budget).
//
// The XMP read/write surface lives next door in `XMPSerialization.swift`
// (`XMPParser` + `XMPSerializer`); the split happened during #632 once the
// extra `dc:subject` handling pushed this file past that same budget.

import Foundation

// MARK: - AdjustmentModel

/// Per-image editing knobs. Mirrors `raw_core::xmp::AdjustmentModel`.
/// All values are stored at full float64 precision (Lightroom uses float32
/// on-wire; we widen to Double here for Swift arithmetic convenience and
/// narrow before the FFI call path).
public struct AdjustmentModel: Codable, Sendable, Equatable, Hashable {
    // White balance
    public var temperature: Double = 6500  // 2000..12000, default 6500
    public var tint: Double = 0  // -150..150 (ACR's crs:Tint span, #1870), default 0
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
    public var wbScaleVersion: Int = 5  // 1 | 5, default 5

    /// User white-balance method (#431; wired into Swift by #2216). Mirrors
    /// `raw_core::types::adjustment::WbMethod`. `.cat16` (default) omits
    /// `papp:WbMethod` on write. See `WbMethod`'s doc comment for the two
    /// variants' math.
    public var wbMethod: WbMethod = .cat16  // default .cat16

    // Basic tone
    public var exposure: Double = 0  // -4..+4 EV, default 0
    /// Brightness — scene-linear midtone-band gain (#1102, tone/zoom design
    /// § 4.1). Runs inside `scene_tone_controls` after exposure, before
    /// highlights/shadows/whites/blacks. XMP key `papp:Brightness` (NOT the
    /// ACR PV2010 `crs:Brightness`, which has different semantics).
    public var brightness: Double = 0  // -100..100, default 0
    public var contrast: Double = 0  // -100..100, default 0
    public var highlights: Double = 0  // -100..100, default 0
    public var shadows: Double = 0  // -100..100, default 0
    public var whites: Double = 0  // -100..100, default 0
    public var blacks: Double = 0  // -100..100, default 0

    // Parametric tone curve — PV2012-style four-region sliders (ticket #273).
    // Synthesises a piecewise-cubic over the canonical region split points
    // (¼, ½, ¾) and applies post-`scene_tone_controls`, pre-`vibrance` in
    // the Rust core. Identity at all-zero. The per-channel POINT curves
    // (`papp:SceneLinearToneCurve*`) are the `toneCurve*` fields further
    // down; their sidecar round-trip landed in #365.
    public var parametricHighlights: Double = 0  // -100..100, default 0
    public var parametricLights: Double = 0  // -100..100, default 0
    public var parametricDarks: Double = 0  // -100..100, default 0
    public var parametricShadows: Double = 0  // -100..100, default 0

    // ACR's parametric split points (`crs:ParametricShadowSplit` /
    // `MidtoneSplit` / `HighlightSplit`, #2320). Round-tripped for sidecar
    // fidelity — a Lightroom/ACR sidecar with moved split points no longer
    // silently loses them on a Maple save. The Rust curve builder does not
    // yet consume these fields (still fixed 25/50/75 constants); wiring
    // them in is tracked in #3152.
    public var parametricShadowSplit: Double = 25  // 0..100, default 25
    public var parametricMidtoneSplit: Double = 50  // 0..100, default 50
    public var parametricHighlightSplit: Double = 75  // 0..100, default 75

    // Presence
    public var vibrance: Double = 0  // -100..100, default 0
    public var saturation: Double = 0  // -100..100, default 0
    public var clarity: Double = 0  // -100..100, default 0
    public var texture: Double = 0  // -100..100, default 0
    public var dehaze: Double = 0  // -100..100, default 0

    // Detail — sharpening
    //
    // Defaults mirror the reference renderer / Lightroom's import baseline
    // (Sharpness=40, Radius=1.0, Detail=25, EdgeMasking=0) so first-open of
    // a sidecar-less RAW looks as sharp as the reference renderer's
    // default-import, not soft. Aligned with the canonical raw-core defaults
    // per #326 — Apple no longer carries a sharpening divergence (was
    // sharpenAmount=45).
    public var sharpenAmount: Double = 40  // 0..150, default 40 (reference import)
    public var sharpenRadius: Double = 1.0  // 0.5..3.0, default 1.0 (reference import)
    public var sharpenDetail: Double = 25  // 0..100, default 25
    public var sharpenMasking: Double = 0  // 0..100, default 0

    // Detail — capture sharpening (Maple-proprietary Richardson-Lucy
    // deconvolution; distinct from the reference renderer's unsharp-mask
    // sliders above).
    // Defaults to 0 (stage skipped) so first-open matches pre-#271 behaviour
    // bit-identically. Per-camera defaults are a follow-up calibration ticket.
    public var captureSharpeningAmount: Double = 0  // 0..100, default 0
    /// Gaussian PSF sigma in pixels (#456). Renamed from
    /// `captureSharpeningRadius` after PR #452 swapped the integer-radius
    /// tripled-box-blur for a true Gaussian. The XMP key
    /// `papp:CaptureSharpeningSigma` is the canonical write key; the legacy
    /// `papp:CaptureSharpeningRadius` is still accepted on read.
    public var captureSharpeningSigma: Double = 1.0  // 0.5..2.0, default 1.0

    // Detail — noise reduction
    public var nrLuminance: Double = 0  // 0..100, default 0
    public var nrColor: Double = 25  // 0..100, default 25

    // S5 effects fields (ticket #643) — identity-stub scalars added so the
    // editor's tool-pill row can wire vignette / grain / split-tone to a
    // canonical field. No pipeline stage consumes these yet; defaults keep
    // first-open output bit-identical to the pre-#643 pipeline. Follow-up
    // tickets track the actual pipeline math.

    // Vignette (§ 3.12). Primary drag-bar field for the Vignette tool is
    // `vignetteAmount`. `vignetteFeather` is carried for XMP round-trip
    // and a future dedicated UI affordance.
    public var vignetteAmount: Double = 0  // -100..100, default 0
    public var vignetteFeather: Double = 50  // 0..100, default 50

    // Grain (§ 3.13). Primary drag-bar field for the Grain tool is
    // `grainAmount`; size + roughness are carried for XMP round-trip.
    public var grainAmount: Double = 0  // 0..100, default 0
    public var grainSize: Double = 25  // 0..100, default 25
    public var grainRoughness: Double = 50  // 0..100, default 50

    // Color Grading (§ 3.14, #275) — supersedes Split Toning exactly as
    // Lightroom's Color Grading panel superseded Split Toning: these five
    // `splitTone*` fields ARE the Color Grading panel's shadow/highlight
    // wheels and balance slider (same fields, same `crs:SplitToning*` XMP
    // keys — ACR's own layout). Primary drag-bar field for the Color
    // Grading tool is `splitToneBalance` (the shadow/highlight/midtone
    // blend point). Hue is in degrees; saturation is `[0, 100]`.
    public var splitToneShadowHue: Double = 0  // 0..360, default 0
    public var splitToneShadowSaturation: Double = 0  // 0..100, default 0
    public var splitToneHighlightHue: Double = 0  // 0..360, default 0
    public var splitToneHighlightSaturation: Double = 0  // 0..100, default 0
    public var splitToneBalance: Double = 0  // -100..100, default 0

    // Color Grading — the rest of the panel beyond the five `splitTone*`
    // fields above: a midtone wheel, a per-zone luminance offset (shadow /
    // midtone / highlight), and an unweighted global wheel that tints every
    // tone. Hue is in degrees; saturation is `[0, 100]`; luminance offsets
    // are `[-100, 100]`. XMP keys are ACR's `crs:ColorGrade*` namespace.
    // See raw-core's `stages::color_grade` for the render math.
    public var colorGradeShadowLuminance: Double = 0  // -100..100, default 0
    public var colorGradeMidtoneHue: Double = 0  // 0..360, default 0
    public var colorGradeMidtoneSaturation: Double = 0  // 0..100, default 0
    public var colorGradeMidtoneLuminance: Double = 0  // -100..100, default 0
    public var colorGradeHighlightLuminance: Double = 0  // -100..100, default 0
    public var colorGradeGlobalHue: Double = 0  // 0..360, default 0
    public var colorGradeGlobalSaturation: Double = 0  // 0..100, default 0
    public var colorGradeGlobalLuminance: Double = 0  // -100..100, default 0

    // HSL per-band adjustments (#1112, tone/zoom design spec § 10.4).
    // Scene-linear Oklab, normalized raised-cosine partition of unity.
    // All three rows (Hue / Saturation / Luminance) × 8 ACR-aligned bands.
    // Range -100..+100, default 0. XMP keys: crs:HueAdjustmentRed, etc.
    // Names match the generated schema (hue_adjustment_red → hueAdjustmentRed).
    public var hueAdjustmentRed: Double = 0  // -100..100, default 0
    public var hueAdjustmentOrange: Double = 0  // -100..100, default 0
    public var hueAdjustmentYellow: Double = 0  // -100..100, default 0
    public var hueAdjustmentGreen: Double = 0  // -100..100, default 0
    public var hueAdjustmentAqua: Double = 0  // -100..100, default 0
    public var hueAdjustmentBlue: Double = 0  // -100..100, default 0
    public var hueAdjustmentPurple: Double = 0  // -100..100, default 0
    public var hueAdjustmentMagenta: Double = 0  // -100..100, default 0
    public var saturationAdjustmentRed: Double = 0  // -100..100, default 0
    public var saturationAdjustmentOrange: Double = 0  // -100..100, default 0
    public var saturationAdjustmentYellow: Double = 0  // -100..100, default 0
    public var saturationAdjustmentGreen: Double = 0  // -100..100, default 0
    public var saturationAdjustmentAqua: Double = 0  // -100..100, default 0
    public var saturationAdjustmentBlue: Double = 0  // -100..100, default 0
    public var saturationAdjustmentPurple: Double = 0  // -100..100, default 0
    public var saturationAdjustmentMagenta: Double = 0  // -100..100, default 0
    public var luminanceAdjustmentRed: Double = 0  // -100..100, default 0
    public var luminanceAdjustmentOrange: Double = 0  // -100..100, default 0
    public var luminanceAdjustmentYellow: Double = 0  // -100..100, default 0
    public var luminanceAdjustmentGreen: Double = 0  // -100..100, default 0
    public var luminanceAdjustmentAqua: Double = 0  // -100..100, default 0
    public var luminanceAdjustmentBlue: Double = 0  // -100..100, default 0
    public var luminanceAdjustmentPurple: Double = 0  // -100..100, default 0
    public var luminanceAdjustmentMagenta: Double = 0  // -100..100, default 0

    // Black & white mix (#276). `blackWhite` toggles the same 8-band Oklab
    // stage the HSL sliders above run through into its monochrome path;
    // the eight `grayMixer*` weights become per-hue-band luminance weights
    // (chroma forced to zero) while it is `.on`. The 24 HSL sliders are
    // inert while `blackWhite` is `.on`; `grayMixer*` is inert while it is
    // `.off`. `BlackWhiteMode` lives in `AdjustmentModel+BlackWhite.swift`
    // (budget split, matching `HighlightRecoveryMode` / `Look` / `Profile`
    // pattern). XMP keys: `crs:ConvertToGrayscale`, `crs:GrayMixerRed`, etc.
    public var blackWhite: BlackWhiteMode = .off
    public var grayMixerRed: Double = 0  // -100..100, default 0
    public var grayMixerOrange: Double = 0  // -100..100, default 0
    public var grayMixerYellow: Double = 0  // -100..100, default 0
    public var grayMixerGreen: Double = 0  // -100..100, default 0
    public var grayMixerAqua: Double = 0  // -100..100, default 0
    public var grayMixerBlue: Double = 0  // -100..100, default 0
    public var grayMixerPurple: Double = 0  // -100..100, default 0
    public var grayMixerMagenta: Double = 0  // -100..100, default 0

    // Highlight recovery (Maple-proprietary)
    public var highlightRecovery: HighlightRecoveryMode = .chromaticAdaptation

    /// Auto-exposure mode (#1387). Decode-time scalar mid-gray anchor gain,
    /// baked into the Rust decode product like `highlightRecovery` above —
    /// no Apple-Metal live re-apply, so `stripAppleGPUStages` keeps it.
    /// Defaults to `.on` (raw-core's parse default). XMP key
    /// `papp:AutoExposure`; `.on` (default) omits the attribute on write.
    public var autoExposure: AutoExposureMode = .on

    // DisplayLookCurve (Maple-proprietary, ticket #371). Defaults to
    // `.default` — new users get the empirical Look.
    public var look: Look = .default

    // Render-shaping profile (Auto Profile Phase 1, ticket #536). Defaults
    // to `.auto`. Replaces the retired `papp:Look` attribute on the write
    // path; the XMP parser migrates legacy `papp:Look` values into this
    // field when `papp:Profile` is absent.
    public var profile: Profile = .auto

    /// Per-channel point tone-curve application mode (#436; wired into
    /// Swift by #2216). Mirrors `raw_core::types::adjustment::ToneCurveMode`.
    /// `.perChannel` (default) omits `papp:ToneCurveMode` on write.
    public var toneCurveMode: ToneCurveMode = .perChannel  // default .perChannel

    // Per-channel point curves (#273 slice 1; schema/codegen in #366).
    // Each is a `ToneCurve` of `(x, y)` control points in `[0, 1]`
    // authoring space, identity when empty — so a default model renders
    // bit-identically to the pre-tone-curve pipeline. `toneCurveLuma`
    // applies channels-uniformly via the Rec.2020 luma weights; the R/G/B
    // curves apply per the core's tone-curve mode. Sidecar round-trip
    // landed in #365 (nested `papp:SceneLinearToneCurve*` elements —
    // `XMPSerialization+ToneCurves.swift`) and the curve editor is #367.
    // Field order mirrors
    // `raw_core::types::AdjustmentModel`.
    public var toneCurveLuma: ToneCurve = .identity  // default .identity (empty)
    public var toneCurveRed: ToneCurve = .identity  // default .identity (empty)
    public var toneCurveGreen: ToneCurve = .identity  // default .identity (empty)
    public var toneCurveBlue: ToneCurve = .identity  // default .identity (empty)

    /// Decode-time chroma pre-filter (#1104, tone/zoom design § 3.1).
    /// Luma-guided sparse cross-bilateral on opponent chroma, baked into
    /// the Rust decode product (post-DCP, pre auto-exposure) — there is
    /// no per-tick Apple chain equivalent, so `stripAppleGPUStages` keeps
    /// it and the decoded-image cache key (the baked model, #950) picks
    /// it up automatically: changing it re-decodes. XMP key
    /// `papp:ChromaPrefilter`; 0 (default) = bit-identical stage skip.
    public var chromaPrefilter: Double = 0  // 0..100, default 0

    /// Hot/dead-pixel suppression (#1106, tone/zoom design § 10.6).
    /// Pre-demosaic, baked into the Rust decode product like
    /// `chromaPrefilter` — kept by `stripAppleGPUStages`, so the #950
    /// baked-model decode-cache key carries it automatically. XMP key
    /// `papp:HotPixelSuppression`; `.off` (default) = bit-identical skip.
    public var hotPixelSuppression: HotPixelSuppressionMode = .off

    /// BM3D deep denoise (#1105, tone/zoom design § 3.2). Input-referred,
    /// baked into the Rust decode product immediately after
    /// `chromaPrefilter` — same KEPT/strip + #950 baked-model cache-key
    /// story (changing it re-decodes; the cached decoded buffer is what
    /// amortises the seconds-scale runtime). XMP key `papp:DeepDenoise`;
    /// 0 (default) = bit-identical stage skip.
    public var deepDenoise: Double = 0  // 0..100, default 0

    /// Geometry — crop rect (normalised to display-oriented dimensions) plus
    /// straighten angle. Default is `Crop.identity` (full frame, 0°). When
    /// identity, the crop stage is skipped and the XMP serializer omits the
    /// whole `crs:Crop*` group. See `Crop` and spec § 3.12.
    public var crop: Crop = .identity  // default .identity

    /// DNG-embedded lens corrections (#376). The vendor's distortion /
    /// lateral-CA / vignetting corrections travel inside the DNG as
    /// `OpcodeList3` opcodes and are resampled into the demosaiced buffer
    /// before DCP — inside the Rust decode product, upstream of every
    /// per-tick Metal stage. Like `chromaPrefilter` these are KEPT by
    /// `stripAppleGPUStages`, so the #950 baked-model decode-cache key
    /// carries them automatically: changing one correctly re-decodes.
    /// XMP key `crs:LensProfileEnable`; `.on` (default) matches ACR.
    public var lensProfileEnable: LensProfileEnable = .on
    /// Geometric-distortion strength — the `WarpRectilinear` component
    /// common to all three planes. XMP `crs:LensProfileDistortionScale`.
    public var lensCorrectionDistortion: Double = 100  // 0..100, default 100
    /// Lateral chromatic-aberration strength — each plane's
    /// `WarpRectilinear` deviation from the green reference plane. XMP
    /// `crs:LensProfileChromaticAberrationScale`.
    public var lensCorrectionCa: Double = 100  // 0..100, default 100
    /// Vignetting / lens-shading strength — the `FixVignetteRadial` and
    /// `GainMap` gain opcodes. XMP `crs:LensProfileVignettingScale`.
    public var lensCorrectionVignetting: Double = 100  // 0..100, default 100

    /// Film-look emulation id (epic #2683) — the `.mlut` catalog id (also its
    /// filename stem), or `""` for "no look" (the default). Resolved to a
    /// decoded lattice via `FilmLutStore`; an id with no matching asset
    /// resolves to `nil` and the render falls back to identity (log + no
    /// error — see `FilmLutStore`). XMP key `papp:FilmLook`; empty (default)
    /// omits the attribute on write.
    public var filmLook: String = ""  // default ""
    /// Film-look blend strength, 0..100 — lerped against the pre-look value
    /// in display-linear space (mirrors every other blend-strength field in
    /// `MapleGpuLiveParams`). XMP key `papp:FilmStrength`; 100 (default,
    /// full look) omits the attribute on write.
    public var filmStrength: Double = 100  // 0..100, default 100


    public static let `default` = AdjustmentModel()

    /// True when this model carries user adjustments that change the
    /// rendered pixels, judged with the white-balance fields excluded.
    ///
    /// `temperature`/`tint`/`wbScaleVersion` must be excluded: on first
    /// open the editor seeds them with the image's as-shot values, so a
    /// rating-only or flag-only sidecar save records non-default WB numbers
    /// that do NOT represent an edit. Comparing against a baseline that
    /// copies those three fields treats those sidecars as visually unedited
    /// — the common culling case — at the cost of also treating a WB-only
    /// edit as unedited. Callers that gate derived-image generation on this
    /// (the `.maple/previews` display tier in `ThumbnailLoader`) accept
    /// that trade-off: a WB-only edit made in the local editor still gets a
    /// correct display preview from the editor-exit render refresh; only a
    /// WB-only edit arriving externally (synced sidecar, never rendered on
    /// this device) slips through.
    ///
    /// `wbMethod` is NOT copied into the baseline (#2216): unlike
    /// temperature/tint, nothing seeds it from the image itself, so a
    /// non-default value only ever comes from an explicit user or
    /// externally-authored choice — a real edit, correctly caught here.
    public var isVisuallyEditedBeyondWhiteBalance: Bool {
        let baseline = AdjustmentModel(
            temperature: temperature,
            tint: tint,
            wbScaleVersion: wbScaleVersion
        )
        return self != baseline
    }
}
