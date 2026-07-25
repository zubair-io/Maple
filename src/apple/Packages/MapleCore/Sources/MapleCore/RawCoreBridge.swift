// RawCoreBridge.swift — Apple side of the raw-ffi contract.
//
// Per ticket #124 the C FFI is "thin marshalling only" — it parses an
// XMP file, hands the parsed `AdjustmentModel` to the raw-core decoder,
// and packs the result. It does NOT mutate the model. The decision of
// which adjustment fields to strip before decode (so the Apple Metal
// chain doesn't double-apply them) lives here.
//
// Architecture: `apply_scene_linear_chain` (Apple's hot path on every
// slider tick) re-applies every scene-linear stage that the Apple side can
// forward — `white_balance` (delta), `scene_tone_controls` (exposure +
// brightness + tone regions), `tone_curves` (parametric), `vibrance`,
// `saturation`, `hsl` (8-band hue/sat/lum), `clarity`, `texture`,
// `dehaze`, `vignette`, `nr_luminance`, then post-AgX `split_tone` +
// `grain`. Each of those scene-linear stages is ALSO baked by the FFI
// decode (`develop_scene_linear_*`, which mirrors the same stage order up
// to but not including AgX). If the decode bakes a chain-handled field with
// the live sidecar value, that stage runs twice and the slider doubles —
// exposure +3.68 EV becomes +7.36 EV, AgX's highlight rolloff produces
// non-linear chroma distortion, and the result on real images is a visible
// magenta cast. So the strip must zero EVERY scene-linear field the decode
// bakes; the list below is the full current set (#1916 closed the gap where
// brightness / parametric / HSL / vignette had grown into the chain via
// #1102/#273/#1112/#1109 without the strip following).
//
// Two Rust-chain scene-linear stages are deliberately absent from that
// list: `local_adjustments` (#280) and the per-channel point `tone_curve*`
// arrays (#273 follow-up). The Swift `AdjustmentModel` does not mirror
// either — `PipelineRenderer.makeParams` cannot forward a field the model
// can't hold — so on the Apple path they are always empty/identity in both
// the decode and the chain. There is nothing to strip and no double-apply.
// When they land on the Swift model they must be added to the strip (and to
// the `SceneLinearChainCache` key).
//
// `split_tone` (#1111) and `grain` (#1110) are a different exception: they
// run only POST-AgX, and the Apple decode stops at scene-linear (pre-AgX),
// so the decode never bakes them and there is nothing to double-apply. They
// are neither stripped nor kept here — they simply never reach the decode.
// (They DO influence the chain output, so they still belong in the
// `SceneLinearChainCache` key — see `SceneLinearChainCache.make`.)
//
// Apple's Metal kernels also re-apply `sharpen` and `nr_color`
// **after** the chain (`ImageEditPipeline.applySceneSharpen` +
// `applySceneNRColor`), so those two are stripped for the same reason
// (and have been since the first iteration of this helper). The Metal
// pass is the SINGLE live post-AgX application — the Rust decode must
// NOT also bake them.
//
// Two kinds of strip live in this helper (#973):
//
//  1. Fields set to `AdjustmentModel()` defaults that **happen to be
//     identity / no-op**, so the corresponding Rust decode stage
//     early-exits naturally (temperature=6500, tint=0, exposure=0,
//     contrast/highlights/shadows/whites/blacks=0, vibrance/saturation/
//     clarity/texture/dehaze=0, nrLuminance=0).
//  2. Fields forced to **literal 0** because their model defaults are
//     NON-ZERO (`nrColor`=25, `sharpenAmount`=40) and the Rust stages
//     only early-exit below `1e-3` (`stages/noise_reduction.rs::apply_color`,
//     `stages/sharpen.rs::apply`). Setting them to the *default* would
//     run `nr_color`@25 (~8.5 s) + `sharpen`@40 (~0.8 s) in the decode
//     AND have Metal re-apply them at the live value — a ~9.3 s wasted
//     double-apply (over-denoise / over-sharpen the single-pass Rust
//     reference doesn't have). Zeroing them makes the decode skip both;
//     Metal owns the one live pass.
//
// Stripped fields:
//   * `temperature`, `tint`        — `white_balance::apply` early-exits
//     at temp=6500/tint=0 (its identity short-circuit). The post-DCP
//     buffer is at D65 (= 6500K) by construction; the chain re-applies
//     the user's full WB shift from this consistent reference.
//   * `exposure`, `brightness`, `contrast`, `highlights`, `shadows`,
//     `whites`, `blacks`  — scene_tone_controls + AgX contrast slope
//     (defaults are identity → decode early-exits). `brightness` (#1102)
//     is the midtone-band gain inside scene_tone_controls.
//   * `parametricHighlights`, `parametricLights`, `parametricDarks`,
//     `parametricShadows` (#273) — the `tone_curves` stage, run by both
//     decode and chain; all-zero is the identity short-circuit.
//   * `toneCurveLuma`, `toneCurveRed`, `toneCurveGreen`, `toneCurveBlue`
//     (#367) — the SAME `tone_curves` stage; the live chain reads them
//     through `MapleGpuLiveParams.tone_curve_*_ptr`, so they double-apply
//     unless zeroed here. The empty curve is the identity short-circuit.
//   * `vibrance`, `saturation`, `clarity`, `texture`, `dehaze` (ditto)
//   * the 24 HSL bands `hueAdjustment*` / `saturationAdjustment*` /
//     `luminanceAdjustment*` (#1112) — the `hsl` stage; all-zero is a
//     bit-identical stage skip on both the decode and the chain.
//   * `blackWhite` + the 8 `grayMixer*` bands (#276) — the SAME `hsl`
//     stage (`hsl::apply_model` reads all three HSL rows plus
//     `black_white`/`gray_mixer_*` together), run by both the decode and
//     the chain, so it double-applies unless zeroed/defaulted here exactly
//     like the 24 HSL bands above.
//   * `vignetteAmount`, `vignetteFeather` (#1109) — the `vignette` stage;
//     amount 0 short-circuits it (feather returns to its 50 default).
//   * `nrLuminance`                — chain applies it; default 0 → decode
//     early-exits without forcing
//   * `nrColor`, `sharpenAmount`   — Apple Metal re-applies post-chain;
//     forced to literal 0 (NOT the 25/40 defaults) to kill the
//     double-apply described above
//
// **Kept** (Apple-irreplaceable, baked at decode only):
//   * `highlightRecovery`          — pre-DCP, no chain equivalent.
//   * `sharpenRadius`, `sharpenDetail`, `sharpenMasking` — read by
//     Apple Metal; not used during decode anyway.
//   * `captureSharpeningAmount`, `captureSharpeningSigma` — runs inside
//     the Rust `develop_scene_linear_*` decode, post-DCP/PGTM, and has
//     no Apple Metal equivalent. Default amount = 0 short-circuits the
//     stage in Rust, so kept fields stay no-op until the user opts in.
//   * `chromaPrefilter` (#1104)    — decode-time chroma pre-filter, runs
//     inside the Rust decode product (post-DCP, pre auto-exposure); no
//     per-tick equivalent anywhere. Default 0 short-circuits the stage.
//     Because it is KEPT, the #950 baked-model decode-cache key carries
//     it automatically — changing the value correctly re-decodes.
//   * `hotPixelSuppression` (#1106) — pre-demosaic defect replacement
//     inside the Rust decode product; same KEPT/cache-key story as
//     `chromaPrefilter`. Default `.off` short-circuits the stage.
//   * `deepDenoise` (#1105)        — BM3D, input-referred inside the Rust
//     decode product; same KEPT/cache-key story. The #950 baked-model key
//     carrying it is what makes the seconds-scale run a ONE-TIME cost per
//     setting: downstream slider ticks reuse the denoised decode. Default
//     0 short-circuits the stage.
//   * `lensProfileEnable` / `lensCorrectionDistortion` /
//     `lensCorrectionCa` / `lensCorrectionVignetting` (#376) — the DNG's
//     own OpcodeList3 lens corrections, resampled into the demosaiced
//     buffer before DCP inside the Rust decode product. There is no
//     Metal per-tick equivalent (and deliberately no WGSL one either —
//     both GPU chains consume the already-corrected decode), so the same
//     KEPT/cache-key story as `chromaPrefilter` applies: changing a scale
//     re-decodes. The defaults (On / 100 / 100 / 100) apply the vendor's
//     correction exactly as it was applied before these fields existed.
//
// **WB contract** (the previously load-bearing source of magenta-cast
// bugs): the strip forces the FFI decode to a fixed reference state
// (D65) regardless of what the sidecar contains, eliminating the
// "first-open at D65, post-sidecar at user-temp" inconsistency.

import Foundation
import os.log

private let bridgeLog = Logger(subsystem: "app.justmaple.aperture", category: "RawCoreBridge")

public enum RawCoreBridge {

    /// Zero the AdjustmentModel fields that Apple's Metal scene-linear
    /// chain re-applies post-decode. Returns a copy; the input is
    /// unchanged. See file header for the strip rationale.
    public static func stripAppleGPUStages(_ model: AdjustmentModel) -> AdjustmentModel {
        let d = AdjustmentModel()  // canonical defaults
        var m = model
        // White balance — chain applies it from a D65 reference (see above).
        m.temperature = d.temperature
        m.tint = d.tint
        // scene_tone_controls (exposure + brightness + tone regions) + AgX
        // contrast. brightness (#1102) is a midtone-band gain inside
        // scene_tone_controls — the decode bakes it and the chain re-applies
        // it, so it must be zeroed here like every other scene_tone control.
        m.exposure = d.exposure
        m.brightness = d.brightness
        m.contrast = d.contrast
        m.highlights = d.highlights
        m.shadows = d.shadows
        m.whites = d.whites
        m.blacks = d.blacks
        // Parametric tone curve (#273) — fed to the `tone_curves` stage,
        // which BOTH the decode and the chain run. Left un-stripped they
        // double-apply exactly like brightness, so zero all four regions.
        m.parametricHighlights = d.parametricHighlights
        m.parametricLights = d.parametricLights
        m.parametricDarks = d.parametricDarks
        m.parametricShadows = d.parametricShadows
        // Per-channel POINT curves (#273 fields, wired to the UI at #367)
        // — the SAME `tone_curves` stage as the four parametric scalars
        // above, and the live wgpu chain now carries them through
        // `MapleGpuLiveParams.tone_curve_*_ptr`. Left un-stripped they
        // would bake into the decoded buffer and then be applied a second
        // time by the chain, so they follow the parametric fields exactly.
        m.toneCurveLuma = d.toneCurveLuma
        m.toneCurveRed = d.toneCurveRed
        m.toneCurveGreen = d.toneCurveGreen
        m.toneCurveBlue = d.toneCurveBlue
        // Hue/sat/local-contrast/dehaze
        m.vibrance = d.vibrance
        m.saturation = d.saturation
        m.clarity = d.clarity
        m.texture = d.texture
        m.dehaze = d.dehaze
        // HSL 8-band hue/sat/lum (#1112) — the `hsl` stage runs in both the
        // decode and the chain (scene-linear Oklab, after saturation), so
        // all 24 bands double-apply unless zeroed here.
        m.hueAdjustmentRed = d.hueAdjustmentRed
        m.hueAdjustmentOrange = d.hueAdjustmentOrange
        m.hueAdjustmentYellow = d.hueAdjustmentYellow
        m.hueAdjustmentGreen = d.hueAdjustmentGreen
        m.hueAdjustmentAqua = d.hueAdjustmentAqua
        m.hueAdjustmentBlue = d.hueAdjustmentBlue
        m.hueAdjustmentPurple = d.hueAdjustmentPurple
        m.hueAdjustmentMagenta = d.hueAdjustmentMagenta
        m.saturationAdjustmentRed = d.saturationAdjustmentRed
        m.saturationAdjustmentOrange = d.saturationAdjustmentOrange
        m.saturationAdjustmentYellow = d.saturationAdjustmentYellow
        m.saturationAdjustmentGreen = d.saturationAdjustmentGreen
        m.saturationAdjustmentAqua = d.saturationAdjustmentAqua
        m.saturationAdjustmentBlue = d.saturationAdjustmentBlue
        m.saturationAdjustmentPurple = d.saturationAdjustmentPurple
        m.saturationAdjustmentMagenta = d.saturationAdjustmentMagenta
        m.luminanceAdjustmentRed = d.luminanceAdjustmentRed
        m.luminanceAdjustmentOrange = d.luminanceAdjustmentOrange
        m.luminanceAdjustmentYellow = d.luminanceAdjustmentYellow
        m.luminanceAdjustmentGreen = d.luminanceAdjustmentGreen
        m.luminanceAdjustmentAqua = d.luminanceAdjustmentAqua
        m.luminanceAdjustmentBlue = d.luminanceAdjustmentBlue
        m.luminanceAdjustmentPurple = d.luminanceAdjustmentPurple
        m.luminanceAdjustmentMagenta = d.luminanceAdjustmentMagenta
        // Black & white mix (#276) — same `hsl` stage as the 24 bands
        // above; zeroed/defaulted here for the same double-apply reason.
        m.blackWhite = d.blackWhite
        m.grayMixerRed = d.grayMixerRed
        m.grayMixerOrange = d.grayMixerOrange
        m.grayMixerYellow = d.grayMixerYellow
        m.grayMixerGreen = d.grayMixerGreen
        m.grayMixerAqua = d.grayMixerAqua
        m.grayMixerBlue = d.grayMixerBlue
        m.grayMixerPurple = d.grayMixerPurple
        m.grayMixerMagenta = d.grayMixerMagenta
        // Vignette (#1109) — scene-linear radial gain, run in both the decode
        // and the chain (after local adjustments, before the omitted sharpen).
        // Zeroing amount short-circuits the stage; feather rides back to its
        // default for a clean neutral reference.
        m.vignetteAmount = d.vignetteAmount
        m.vignetteFeather = d.vignetteFeather
        // Noise reduction (chain handles luminance; Metal handles color).
        // nrLuminance default is 0 → decode early-exits, so default is fine.
        m.nrLuminance = d.nrLuminance
        // nrColor / sharpenAmount: literal 0, NOT the 25/40 model defaults
        // (#973). Their defaults are non-zero and the Rust decode only
        // early-exits below 1e-3, so defaulting would run the stage in the
        // decode AND have Metal re-apply it post-AgX — a double-apply.
        // Zero makes the decode skip both; Metal owns the single live pass.
        m.nrColor = 0
        // Sharpen (Apple Metal handles — see nrColor note above).
        m.sharpenAmount = 0
        return m
    }

    /// Call `body` with a path to a temporary XMP sidecar whose contents
    /// are `original` with `stripAppleGPUStages` applied. The temp file
    /// is created in `FileManager.default.temporaryDirectory` and removed
    /// on `defer` regardless of whether `body` throws.
    ///
    /// `profileOverride` (#871): when non-nil, the stripped model's
    /// `profile` is forced to this value before the temp XMP is written —
    /// regardless of what the on-disk sidecar says. The decode's
    /// auto-exposure decision (raw-ffi forces `auto_exposure: Off` when an
    /// Auto Profile curve will fit) keys off this profile, so the LIVE
    /// profile selection must drive the decode rather than the sidecar's
    /// possibly-stale value (the sidecar write is debounced; a fresh-open
    /// with no sidecar would otherwise rely on raw-core's default). This
    /// keeps the Apple Auto displayed buffer developed AE-Off — matching
    /// the buffer the Auto curve was fit against — so AE-lift and
    /// curve-lift don't stack and blow out highlights. `nil` preserves the
    /// sidecar's profile (the pre-#871 behaviour).
    ///
    /// When `original` is `nil` AND `profileOverride` is `nil`, `body` is
    /// called with `nil` directly — no temp file is written. The raw-ffi
    /// treats a null xmp_path as "use AdjustmentModel::default()". Note
    /// (#973): that default is NOT identical to the stripped model — the
    /// strip forces `nrColor`/`sharpenAmount` to 0 while the Rust default
    /// bakes them at 25/40 (non-zero, so the decode runs both stages).
    ///
    /// The nil/nil branch IS reachable: unit tests and the tile /
    /// `openRawHandle` openers (`renderTile`, `decodePreviewTile`,
    /// `decodeSceneLinear` called without a `profileOverride`) all arrive
    /// here. On that path the decode runs with `AdjustmentModel::default()`
    /// (nrColor=25, sharpenAmount=40), but those callers do NOT execute the
    /// Apple Metal post-decode `nr_color`/`sharpen` re-apply pass — so
    /// there is no double-apply on this path.
    ///
    /// The PRODUCTION scene-linear AgX path (the one that WOULD double-apply
    /// if nrColor/sharpenAmount were left non-zero in the decode) always
    /// passes a non-nil `profileOverride`. That means it always takes the
    /// strip-temp-XMP branch, which zeros both fields before the decode —
    /// Metal then owns the sole live pass. This invariant is what #977
    /// enforces; the nil/nil shortcut is never taken by that path.
    ///
    /// When `profileOverride` is non-nil a temp XMP is always written (even
    /// with no sidecar) so the override lands.
    ///
    /// When `original` cannot be read or parsed, `body` is still called
    /// with a temp XMP derived from `AdjustmentModel()` so the FFI call
    /// proceeds with default behaviour rather than failing. The parse
    /// error is logged so we can spot bad sidecars without breaking the
    /// open path. Rust's xmp::parse is permissive (unknown attrs are
    /// silently ignored); Swift's `XMPParser.parse` is similarly
    /// permissive, so reaching this branch normally means a non-XMP
    /// file at the sidecar URL.
    public static func withStrippedXMP<T>(
        _ original: URL?,
        profileOverride: Profile? = nil,
        autoExposureOverride: AutoExposureMode? = nil,
        body: (URL?) throws -> T
    ) throws -> T {
        guard original != nil || profileOverride != nil || autoExposureOverride != nil else {
            return try body(nil)
        }
        var stripped: AdjustmentModel
        let culling: CullingState
        if let original {
            do {
                let xml = try String(contentsOf: original, encoding: .utf8)
                let parsed = try XMPParser.parse(xml)
                stripped = stripAppleGPUStages(parsed.0)
                culling = parsed.1
            } catch {
                bridgeLog.warning("withStrippedXMP: failed to read/parse \(original.path, privacy: .public): \(error.localizedDescription, privacy: .public). Falling back to defaults.")
                stripped = stripAppleGPUStages(AdjustmentModel())
                culling = CullingState()
            }
        } else {
            // No sidecar but an override is requested — start from
            // canonical defaults so the override is the only deviation.
            stripped = stripAppleGPUStages(AdjustmentModel())
            culling = CullingState()
        }
        applyOverrides(profileOverride: profileOverride, autoExposureOverride: autoExposureOverride, to: &stripped)
        return try withTemporaryXMP(model: stripped, culling: culling, body: body)
    }

    /// Variant of `withStrippedXMP` for renderers that must use the live
    /// in-memory model instead of waiting for the debounced sidecar write.
    /// The RAW-handle tile path uses this once when it opens a handle, then
    /// reuses the parsed stripped model for every visible-region render.
    public static func withStrippedModelXMP<T>(
        _ model: AdjustmentModel,
        profileOverride: Profile? = nil,
        autoExposureOverride: AutoExposureMode? = nil,
        body: (URL?) throws -> T
    ) throws -> T {
        var stripped = stripAppleGPUStages(model)
        applyOverrides(profileOverride: profileOverride, autoExposureOverride: autoExposureOverride, to: &stripped)
        return try withTemporaryXMP(
            model: stripped,
            culling: CullingState(),
            body: body
        )
    }

    /// Force the LIVE (in-memory session) `profile` and/or `autoExposure`
    /// into the stripped model before it's written to the decode's temp
    /// XMP — regardless of what the possibly-stale on-disk sidecar says.
    ///
    /// `profileOverride` (#871): the decode's auto-exposure-Off-when-Auto
    /// decision keys off `profile`, so the live selection must drive the
    /// decode rather than the debounced sidecar write.
    ///
    /// `autoExposureOverride` (#1387): `auto_exposure` is itself a
    /// decode-baked field (like `profile`), so it has the exact same
    /// staleness problem — `EditorState.applyAuto` sets the LIVE model's
    /// `autoExposure` to `.off` alongside `exposure` so a `Profile.neutral`
    /// decode doesn't double-count the AE anchor gain under AUTO's
    /// recommendation, and that must land on the SAME render tick, not
    /// ~750ms later when the debounced sidecar write finally lands.
    private static func applyOverrides(
        profileOverride: Profile?,
        autoExposureOverride: AutoExposureMode?,
        to model: inout AdjustmentModel
    ) {
        if let profileOverride {
            model.profile = profileOverride
            // Guard the serialize→parse round-trip: the serializer omits
            // `papp:Profile` for `.auto`, and raw-core then MIGRATES a
            // `papp:Look="Neutral"` into `Profile::Neutral` (legacy #536
            // migration, gated on no explicit `papp:Profile`). A
            // Look=Neutral sidecar would therefore silently flip our Auto
            // override back to Neutral on the decode side. The Look field
            // is a retired no-op (#443) and the pre-AgX decode never reads
            // it, so neutralise it here so the override is the sole signal.
            model.look = .default
        }
        if let autoExposureOverride {
            model.autoExposure = autoExposureOverride
        }
    }

    private static func withTemporaryXMP<T>(
        model: AdjustmentModel,
        culling: CullingState,
        body: (URL?) throws -> T
    ) throws -> T {
        // `omitWhiteBalance` (#1883): the decode contract is "WB no-ops at
        // decode; the Apple chain re-applies it live as a delta". Since
        // #1726's camera-space WB, writing an EXPLICIT crs:Temperature=6500
        // crs:Tint=0 parses as an authored Custom WB (temperature_seen /
        // tint_seen true) and retargets the camera-space stage to D65 —
        // diverging from the CPU reference's As-Shot no-op on the same
        // image. Omitting the WB attributes keeps both flags false, which
        // is the As-Shot resolution on BOTH WB stages — the same semantics
        // `PipelineRenderer.render(xmpPath: nil)` gets from an absent model.
        // This applies to BOTH decode temp-XMP writers: the sidecar-derived
        // `withStrippedXMP` and the live-model `withStrippedModelXMP` (the
        // native-detail tile path re-applies WB live through the decoded
        // temperature/tint anchors, exactly like the whole-image chain).
        let xml = XMPSerializer.serialize(model: model, culling: culling, omitWhiteBalance: true)
        // Unique temp file name — UUID avoids collision across concurrent
        // renders, and the .xmp suffix keeps the extension intact so any
        // downstream extension-based dispatching still sees an XMP.
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-strip-\(UUID().uuidString).xmp")
        do {
            try xml.write(to: tmp, atomically: true, encoding: .utf8)
        } catch {
            bridgeLog.error("withStrippedXMP: failed to write temp XMP \(tmp.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            // Fall back to nil — FFI uses AdjustmentModel::default,
            // which is the same defaults the strip would produce.
            return try body(nil)
        }
        defer { try? FileManager.default.removeItem(at: tmp) }
        return try body(tmp)
    }
}
