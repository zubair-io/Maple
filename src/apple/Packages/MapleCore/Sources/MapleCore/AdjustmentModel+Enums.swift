// AdjustmentModel+Enums.swift — the pipeline-shaping enums `AdjustmentModel`
// carries as fields.
//
// Split out of `AdjustmentModel.swift` in #376 to keep that file under
// `CONTRIBUTING.md`'s 600-line hard budget — the same reason `BlackWhiteMode`
// (#276), `Crop` / `ToneCurve` (#366), and `CullingState` (#1656) already
// live in their own files. The memberwise `init` is the one member that
// cannot move: put it in an extension and the compiler re-synthesises a
// colliding internal memberwise init, so the enums move instead.
//
// Pure move — each type, its raw values, and its doc comment are unchanged.
// Mirrors of `raw_core::types::adjustment::{HighlightRecoveryMode, Look,
// Profile, HotPixelSuppressionMode, LensProfileEnable, AutoExposureMode}`.

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

// MARK: - LensProfileEnable

/// Master on/off for the lens corrections a DNG embeds in its
/// `OpcodeList3` (#376). Mirrors
/// `raw_core::types::adjustment::LensProfileEnable`. `off` overrides the
/// three `lensCorrection*` scales; `on` (default) applies each family at
/// its own scale, which is ACR's behaviour when the DNG carries a profile
/// and a no-op on a RAW that carries none. XMP key
/// `crs:LensProfileEnable`, written in ACR's "1"/"0" spelling.
public enum LensProfileEnable: String, Codable, Sendable, Hashable, CaseIterable {
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
/// fit; `Profile.neutral` applies it as written. AUTO
/// (`EditorState.applyAuto`) sets it to `.off` alongside `exposure` on
/// every profile since its recommendation is measured against an AE-Off
/// probe — skipping that on Neutral would double-count the anchor gain.
public enum AutoExposureMode: String, Codable, Sendable, Hashable, CaseIterable {
    case on  = "On"
    case off = "Off"
}

// MARK: - WbMethod

/// User white-balance method (ticket #431; wired into Swift by #2216).
/// Mirrors `raw_core::types::adjustment::WbMethod`. Both methods consume the
/// same `(temperature, tint)` pair; they differ only in the matrix applied
/// to the working buffer.
///
/// `.cat16` (default) is proper CAT16 cone-space chromatic adaptation —
/// neutrals stay neutral across the slider range. `.diagonalRec2020` is the
/// legacy von-Kries per-channel-gain approximation, kept for parity A/B
/// comparison; its tint sign is inverted vs `.cat16`'s reference-renderer
/// convention (preserved as-is so pre-#431 output stays bit-identical when
/// selected explicitly). XMP key `papp:WbMethod`; `.cat16` omits the
/// attribute on write. No per-tick GPU-live re-apply beyond the scalar
/// passed at `MapleGpuLiveParams.wb_method` (`GpuLiveParams.swift`); the CPU
/// decode path picks it up from the temp-XMP `RawCoreBridge` writes, since
/// raw-core's own parser already understands the attribute.
public enum WbMethod: String, Codable, Sendable, Hashable, CaseIterable {
    case cat16 = "Cat16"
    case diagonalRec2020 = "DiagonalRec2020"
}

// MARK: - ToneCurveMode

/// Per-channel point tone-curve application mode (ticket #436; wired into
/// Swift by #2216). Mirrors `raw_core::types::adjustment::ToneCurveMode`.
///
/// `.perChannel` (default) applies the R/G/B point curves independently per
/// lane, which can shift hue; `.ratioPreserving` folds them into a single
/// Rec.2020 luma scale factor that preserves the R:G:B ratio. XMP key
/// `papp:ToneCurveMode`; `.perChannel` omits the attribute on write.
public enum ToneCurveMode: String, Codable, Sendable, Hashable, CaseIterable {
    case perChannel = "PerChannel"
    case ratioPreserving = "RatioPreserving"
}
