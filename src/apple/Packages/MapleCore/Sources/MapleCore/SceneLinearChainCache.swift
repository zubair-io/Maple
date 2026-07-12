// SceneLinearChainCache.swift — single-entry LRU around the FFI chain.
//
// Ticket #661: memoize `applySceneLinearChainViaFFI` output keyed on
// `(assetId, hash(scene-linear AdjustmentModel inputs), extent)`. On hit,
// the FFI round-trip (≈50 ms readback + Rust CPU chain on a 1920×1080 f32
// RGBA buffer) is skipped entirely and the cached CIImage is handed to the
// post-FFI Metal kernels (sharpen + nr_color). The sharpen / nr_color /
// captureSharpening sliders are deliberately EXCLUDED from the hash — when
// the user drags one of them the hash matches and we go straight to the
// GPU kernels.
//
// Scope:
//
//   • One cache instance per `ImageEditPipeline` (i.e. per `EditSession`).
//     The cache is single-entry by design: the next render with a fresh
//     model invalidates the previous slot. Multi-entry LRU would add
//     residency pressure (a 1920×1080 f32 RGBA buffer is ~33 MB) without
//     buying anything — the slider drag pattern is "same asset, same
//     scene-linear knobs, sweep a post-FFI slider", which a single slot
//     already serves perfectly.
//
//   • Thread-safe via `NSLock`. Cannot live as actor-isolated state on
//     `ImageEditPipeline` because the FFI helper is `nonisolated` and
//     synchronous (no `await`). Mirrors the lock idiom used by
//     `FileProvider/WorkingSet.swift` and friends. Marked
//     `@unchecked Sendable` for the CIImage payload — CIImage is a
//     reference type and the value is published only under the lock.
//
//   • Hash uses `Hasher` over every scene-linear develop field the FFI
//     chain applies (see `make(...)` for the exhaustive list), plus the
//     three FFI parameters (`decodedTemperature`, `decodedTint`, `skipAgX`)
//     and the WB slider frame. Float fields go through `bitPattern` so
//     NaN / -0 hash consistently. Float NaN equality is excluded by design
//     — the model is bounded by `AdjustmentModel`'s `[-100, 100]` etc
//     ranges, NaN is unreachable in practice. The hash is intentionally
//     over-inclusive on the scene-linear side (extra fields waste hits but
//     never corrupt output); it must never be UNDER-inclusive. #1916 closed
//     the under-inclusive gap where brightness / the 24 HSL bands / vignette
//     / split-tone / grain had grown into the chain (#1102/#1112/#1109/
//     #1111/#1110) without the key following.
//
// Correctness invariants:
//
//   • The hash MUST cover every input that influences the FFI output.
//     Missing an input means a stale cached CIImage gets returned and the
//     user sees wrong pixels. Over-inclusion (caching extra non-FFI
//     fields) wastes hits but never corrupts output.
//
//   • The `extent` (CGSize) is part of the key because `processSceneLinear`
//     prescales BEFORE the FFI call: the fast pass and refine pass run
//     the same model at different viewport sizes. Without the extent in
//     the key, a refine pass on an unchanged model would silently return
//     the preview-resolution cached image — a quality regression.
//
//   • Cache is populated only on the SUCCESS path. The two error returns
//     in `applySceneLinearChainViaFFI` (render-failure / FFI-error
//     fallthroughs that return `scaled`) must NOT cache: a recovered
//     pipeline state on the next tick would then read a fallthrough
//     image where the actual FFI output would land.
//
// Cache disable hook:
//
//   Setting the environment variable `MAPLE_DISABLE_FFI_CACHE=1` forces
//   every lookup to miss and every store to no-op. Used by the perf
//   bench's "cache disabled" baseline so we can measure the slider-tick
//   delta without ripping the cache out at compile time.

import Foundation
import CoreImage

// MARK: - SceneLinearChainCache

/// Single-entry LRU cache for the output of
/// `ImageEditPipeline.applySceneLinearChainViaFFI`. See file-header for
/// the design rationale and correctness invariants.
final class SceneLinearChainCache: @unchecked Sendable {

    // MARK: - Key

    /// Compound key — asset id × hash of the FFI-affecting inputs × the
    /// extent the input CIImage was scaled to (fast vs refine pass).
    struct Key: Hashable {
        let assetID: UUID
        /// `Hasher`-derived digest of every scene-linear `AdjustmentModel`
        /// field the FFI chain applies, plus `decodedTemperature` /
        /// `decodedTint` / `skipAgX` / the WB slider frame. See `make(...)`
        /// for the exhaustive field list.
        let modelDigest: Int
        let width: Int
        let height: Int
    }

    // MARK: - State

    private let lock = NSLock()
    /// Single LRU slot — most recent (key, value). New write evicts.
    private var slot: (key: Key, value: CIImage)?

    /// Honours `MAPLE_DISABLE_FFI_CACHE=1`. Cached at init so the env
    /// lookup doesn't run on every tick.
    private let disabled: Bool

    init() {
        self.disabled = ProcessInfo.processInfo.environment["MAPLE_DISABLE_FFI_CACHE"] == "1"
    }

    // MARK: - Lookup / store

    /// Return the cached CIImage for `key`, or `nil` on miss / disabled.
    func get(_ key: Key) -> CIImage? {
        if disabled { return nil }
        lock.lock()
        defer { lock.unlock() }
        guard let slot, slot.key == key else { return nil }
        return slot.value
    }

    /// Replace the single slot with `(key, value)`. Subsequent reads on
    /// the same key hit until the next put evicts it.
    func put(_ key: Key, _ value: CIImage) {
        if disabled { return }
        lock.lock()
        defer { lock.unlock() }
        slot = (key, value)
    }

    /// Drop the cache slot (used by tests; production callers do not
    /// need this — `put` already evicts on the next render).
    func invalidate() {
        lock.lock()
        defer { lock.unlock() }
        slot = nil
    }

    // MARK: - Hash construction

    /// Build the model digest. The digest covers EVERY scene-linear develop
    /// field the FFI chain (`apply_scene_linear_chain`) applies, plus the
    /// three FFI parameters and the WB slider frame. The exact membership,
    /// in chain order (this list is the contract #1927/#1928 build on):
    ///
    ///   1. white_balance:  `temperature`, `tint`
    ///   2. scene_tone:     `exposure`, `brightness`, `contrast`,
    ///                      `highlights`, `shadows`, `whites`, `blacks`
    ///   3. tone_curves:    `parametricHighlights`, `parametricLights`,
    ///                      `parametricDarks`, `parametricShadows`
    ///   4. presence:       `vibrance`, `saturation`
    ///   5. hsl (24 bands): `hueAdjustment{Red…Magenta}`,
    ///                      `saturationAdjustment{Red…Magenta}`,
    ///                      `luminanceAdjustment{Red…Magenta}`
    ///   6. local contrast: `clarity`, `texture`, `dehaze`
    ///   7. vignette:       `vignetteAmount`, `vignetteFeather`
    ///   8. noise:          `nrLuminance`
    ///   9. split_tone:     `splitToneShadowHue`, `splitToneShadowSaturation`,
    ///                      `splitToneHighlightHue`,
    ///                      `splitToneHighlightSaturation`, `splitToneBalance`
    ///  10. grain:          `grainAmount`, `grainSize`, `grainRoughness`
    ///  11. FFI params:     `decodedTemperature`, `decodedTint`, `skipAgX`
    ///  12. AgX flags:      `highlightRecovery`, `look`, `profile`
    ///  13. WB frame:       `wbFrame.sceneCCT`, `wbFrame.asShotTint`
    ///
    /// Every scalar above is a `Double` folded in via `bitPattern`; the
    /// enums (`highlightRecovery` / `look` / `profile`) and the `Bool`
    /// (`skipAgX`) fold in via their `Hashable` conformance. The order is
    /// fixed — `Hasher` is order-sensitive, so a reorder is a key change.
    ///
    /// Deliberately EXCLUDED — the post-FFI Metal sliders: `sharpenAmount`
    /// / `sharpenRadius` / `sharpenDetail` / `sharpenMasking`, `nrColor`,
    /// and `captureSharpeningAmount` / `captureSharpeningSigma`. Dragging one
    /// of those hits the cache and re-runs only the Metal kernels — that's
    /// the whole point. Fields the Swift `AdjustmentModel` does not mirror
    /// (`local_adjustments`, the per-channel point `tone_curve*` arrays) are
    /// absent here because they can never reach the Apple FFI decode; when
    /// they land on Swift they must be added to this digest.
    ///
    /// `Float.bitPattern` is used so -0.0 / +0.0 hash to the same digest
    /// (they're equal under `==` and we want cache equality to follow
    /// numeric equality). NaN is treated as out-of-range and not handled
    /// specially — `AdjustmentModel` slider ranges (`[-100, 100]` etc)
    /// never produce NaN.
    static func make(
        assetID: UUID,
        model: AdjustmentModel,
        decodedTemperature: Double,
        decodedTint: Double,
        skipAgX: Bool,
        width: Int,
        height: Int,
        wbFrame: WbSliderFrame? = nil
    ) -> Key {
        var h = Hasher()

        // Every scene-linear develop field the FFI chain
        // (`apply_scene_linear_chain`) applies, in chain order. The chain
        // and the decode share this stage list; a field that reaches the
        // chain reaches the FFI output, so it MUST be here. The only develop
        // knobs deliberately EXCLUDED are the post-FFI Metal ones — sharpen*
        // / nrColor / captureSharpening* — which is the whole point of the
        // cache. See `make(...)`'s doc for the exhaustive membership list.

        // white_balance (delta) — temperature/tint plus the decoded
        // baseline + wbFrame threaded through the FFI params below.
        h.combine(model.temperature.bitPattern)
        h.combine(model.tint.bitPattern)
        // scene_tone_controls — exposure, brightness (#1102), contrast, and
        // the four tone regions.
        h.combine(model.exposure.bitPattern)
        h.combine(model.brightness.bitPattern)
        h.combine(model.contrast.bitPattern)
        h.combine(model.highlights.bitPattern)
        h.combine(model.shadows.bitPattern)
        h.combine(model.whites.bitPattern)
        h.combine(model.blacks.bitPattern)
        // tone_curves — parametric four-region curve (#273).
        h.combine(model.parametricHighlights.bitPattern)
        h.combine(model.parametricLights.bitPattern)
        h.combine(model.parametricDarks.bitPattern)
        h.combine(model.parametricShadows.bitPattern)
        // vibrance / saturation.
        h.combine(model.vibrance.bitPattern)
        h.combine(model.saturation.bitPattern)
        // hsl — the 8-band hue/sat/lum grid (#1112), chain order = after
        // saturation, before clarity.
        h.combine(model.hueAdjustmentRed.bitPattern)
        h.combine(model.hueAdjustmentOrange.bitPattern)
        h.combine(model.hueAdjustmentYellow.bitPattern)
        h.combine(model.hueAdjustmentGreen.bitPattern)
        h.combine(model.hueAdjustmentAqua.bitPattern)
        h.combine(model.hueAdjustmentBlue.bitPattern)
        h.combine(model.hueAdjustmentPurple.bitPattern)
        h.combine(model.hueAdjustmentMagenta.bitPattern)
        h.combine(model.saturationAdjustmentRed.bitPattern)
        h.combine(model.saturationAdjustmentOrange.bitPattern)
        h.combine(model.saturationAdjustmentYellow.bitPattern)
        h.combine(model.saturationAdjustmentGreen.bitPattern)
        h.combine(model.saturationAdjustmentAqua.bitPattern)
        h.combine(model.saturationAdjustmentBlue.bitPattern)
        h.combine(model.saturationAdjustmentPurple.bitPattern)
        h.combine(model.saturationAdjustmentMagenta.bitPattern)
        h.combine(model.luminanceAdjustmentRed.bitPattern)
        h.combine(model.luminanceAdjustmentOrange.bitPattern)
        h.combine(model.luminanceAdjustmentYellow.bitPattern)
        h.combine(model.luminanceAdjustmentGreen.bitPattern)
        h.combine(model.luminanceAdjustmentAqua.bitPattern)
        h.combine(model.luminanceAdjustmentBlue.bitPattern)
        h.combine(model.luminanceAdjustmentPurple.bitPattern)
        h.combine(model.luminanceAdjustmentMagenta.bitPattern)
        // clarity / texture / dehaze.
        h.combine(model.clarity.bitPattern)
        h.combine(model.texture.bitPattern)
        h.combine(model.dehaze.bitPattern)
        // vignette (#1109) — scene-linear radial gain, chain order = after
        // dehaze/local-adjustments, before nr_luminance.
        h.combine(model.vignetteAmount.bitPattern)
        h.combine(model.vignetteFeather.bitPattern)
        // nr_luminance (nr_color stays Metal-side, excluded above).
        h.combine(model.nrLuminance.bitPattern)
        // Post-AgX display-domain stages — split_tone (#1111) then grain
        // (#1110). Applied only when `skipAgX` is false; hashing them
        // unconditionally is over-inclusive (safe) and keeps the key correct
        // on the RAW path where they DO shape the output.
        h.combine(model.splitToneShadowHue.bitPattern)
        h.combine(model.splitToneShadowSaturation.bitPattern)
        h.combine(model.splitToneHighlightHue.bitPattern)
        h.combine(model.splitToneHighlightSaturation.bitPattern)
        h.combine(model.splitToneBalance.bitPattern)
        h.combine(model.grainAmount.bitPattern)
        h.combine(model.grainSize.bitPattern)
        h.combine(model.grainRoughness.bitPattern)

        // FFI parameters threaded through `applySceneLinearChainViaFFI`.
        h.combine(decodedTemperature.bitPattern)
        h.combine(decodedTint.bitPattern)
        h.combine(skipAgX)

        // The Rust chain's behaviour also depends on `highlightRecovery`
        // and the AgX `look` / `profile` flags — `look_mode` is a
        // hard-coded `1` today in `PipelineRenderer.makeParams` so it's
        // not a free input, but the FFI surface will widen as #509 lands.
        // Mixing them into the digest now means a future surface widening
        // doesn't silently produce stale cached pixels.
        h.combine(model.highlightRecovery)
        h.combine(model.look)
        h.combine(model.profile)

        // WB slider frame (#1781): the frame changes the chain's WB math,
        // and it ARRIVES asynchronously (the decode export lands after the
        // CIRAWFilter-era placeholder renders) — without it in the digest a
        // pre-frame render could serve for a post-frame tick at identical
        // slider values. The discriminating floats are enough: a frame is
        // per-asset constant once present.
        h.combine(wbFrame?.sceneCCT.bitPattern ?? 0)
        h.combine(wbFrame?.asShotTint.bitPattern ?? 0)

        return Key(
            assetID: assetID,
            modelDigest: h.finalize(),
            width: width,
            height: height
        )
    }
}
