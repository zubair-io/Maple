// RawCoreBridge.swift — Apple side of the raw-ffi contract.
//
// Per ticket #124 the C FFI is "thin marshalling only" — it parses an
// XMP file, hands the parsed `AdjustmentModel` to the raw-core decoder,
// and packs the result. It does NOT mutate the model. The decision of
// which adjustment fields to strip before decode (so the Apple Metal
// chain doesn't double-apply them) lives here.
//
// Architecture: `apply_scene_linear_chain` (Apple's hot path on every
// slider tick) applies the FULL model — `scene_tone_controls`,
// `vibrance`, `saturation`, `clarity`, `texture`, `dehaze`,
// `nr_luminance`, AgX (contrast). If the decode **also** bakes those
// fields with the live sidecar values, every chain-handled stage runs
// twice and slider values double — exposure +3.68 EV becomes +7.36 EV,
// AgX's highlight rolloff produces non-linear chroma distortion, and
// the result on real images is a visible magenta cast.
//
// Apple's Metal kernels also re-apply `sharpen` and `nr_color`
// **after** the chain, so those two are stripped for the same reason
// (and have been since the first iteration of this helper).
//
// Stripped fields (set to the same defaults `AdjustmentModel()` uses so
// the corresponding stages early-exit during decode):
//   * `temperature`, `tint`        — `white_balance::apply` early-exits
//     at temp=6500/tint=0 (its identity short-circuit). The post-DCP
//     buffer is at D65 (= 6500K) by construction; the chain re-applies
//     the user's full WB shift from this consistent reference.
//   * `exposure`, `contrast`, `highlights`, `shadows`, `whites`,
//     `blacks`  — scene_tone_controls + AgX contrast slope
//   * `vibrance`, `saturation`, `clarity`, `texture`, `dehaze`
//   * `nrLuminance`                — chain applies it
//   * `sharpenAmount`, `nrColor`   — Apple Metal re-applies post-chain
//
// **Kept** (Apple-irreplaceable, baked at decode only):
//   * `highlightRecovery`          — pre-DCP, no chain equivalent.
//   * `sharpenRadius`, `sharpenDetail`, `sharpenMasking` — read by
//     Apple Metal; not used during decode anyway.
//   * `captureSharpeningAmount`, `captureSharpeningSigma` — runs inside
//     the Rust `develop_scene_linear_*` decode, post-DCP/PGTM, and has
//     no Apple Metal equivalent. Default amount = 0 short-circuits the
//     stage in Rust, so kept fields stay no-op until the user opts in.
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
        // scene_tone_controls + AgX contrast
        m.exposure = d.exposure
        m.contrast = d.contrast
        m.highlights = d.highlights
        m.shadows = d.shadows
        m.whites = d.whites
        m.blacks = d.blacks
        // Hue/sat/local-contrast/dehaze
        m.vibrance = d.vibrance
        m.saturation = d.saturation
        m.clarity = d.clarity
        m.texture = d.texture
        m.dehaze = d.dehaze
        // Noise reduction (chain handles luminance; Metal handles color)
        m.nrLuminance = d.nrLuminance
        m.nrColor = d.nrColor
        // Sharpen (Apple Metal handles)
        m.sharpenAmount = d.sharpenAmount
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
    /// treats a null xmp_path as "use AdjustmentModel::default()", which is
    /// already in the "stripped" state (every field is at the default value
    /// the strip would assign). When `profileOverride` is non-nil a temp
    /// XMP is always written (even with no sidecar) so the override lands.
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
        body: (URL?) throws -> T
    ) throws -> T {
        guard original != nil || profileOverride != nil else {
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
            // No sidecar but a profile override is requested — start from
            // canonical defaults so the override is the only deviation.
            stripped = stripAppleGPUStages(AdjustmentModel())
            culling = CullingState()
        }
        if let profileOverride {
            stripped.profile = profileOverride
            // Guard the serialize→parse round-trip: the serializer omits
            // `papp:Profile` for `.auto`, and raw-core then MIGRATES a
            // `papp:Look="Neutral"` into `Profile::Neutral` (legacy #536
            // migration, gated on no explicit `papp:Profile`). A
            // Look=Neutral sidecar would therefore silently flip our Auto
            // override back to Neutral on the decode side. The Look field
            // is a retired no-op (#443) and the pre-AgX decode never reads
            // it, so neutralise it here so the override is the sole signal.
            stripped.look = .default
        }
        let xml = XMPSerializer.serialize(model: stripped, culling: culling)
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
