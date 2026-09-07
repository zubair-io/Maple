//! TypeScript enum-union declarations for the adjustment schema — split
//! out of `adjustment.rs` in #3413 to keep that file under CONTRIBUTING.md's
//! 570-line headroom budget, the same reason `adjustment.rs` itself was
//! split out of `main.rs` in #366.
//!
//! Every union here is hand-mirrored from a Rust enum in
//! `raw_core::types::adjustment`, because the flat `ADJUSTMENT_SCHEMA` table
//! carries an enum's *name* but not its variants. The
//! `enum_defaults_are_pinned` coverage in `adjustment.rs` and the
//! codegen-drift CI job are what keep the two in step.

pub(crate) fn emit_enum_types(s: &mut String) {
    // HighlightRecoveryMode union. `Blend` and `Luminance` are legacy
    // back-compat variants kept so old XMP sidecars continue to parse;
    // both upgrade to `ChromaticAdaptation` at apply time (see
    // raw-core::stages::highlight_recovery). Emitted in the multi-line
    // form prettier produces past its print-width threshold so the
    // codegen-drift + format-check gates agree without a post-step
    // through `prettier --write`.
    s.push_str(
        "export type HighlightRecoveryMode =\n  \
         | 'Off'\n  \
         | 'Blend'\n  \
         | 'Luminance'\n  \
         | 'ChromaticAdaptation'\n  \
         | 'OklabChromaReduction';\n\n",
    );

    // DisplayLookCurve (ticket #371; retired in #443 — Wave-3 closing step
    // of #416). Both variants are now identical no-ops at the pipeline
    // level; the enum is kept on `AdjustmentModel` and emitted to Swift /
    // TS so `papp:Look` in pre-#443 sidecars round-trips. See
    // `raw-core::types::adjustment::Look`.
    s.push_str("export type Look = 'Neutral' | 'Default';\n\n");

    // Render-shaping profile (Auto Profile Phase 1, ticket #536). `Auto`
    // (default) fits a per-image curve from the embedded JPEG preview at
    // render time; `Neutral` runs the AgX scene-referred view transform.
    // A third variant `AcrMatch` (#1722) was retired in #2312 — `Auto` fits
    // per-image against the same reference the chart fit approximated,
    // without the over-exposure it showed on real bodies. Pre-#536 sidecars
    // carrying `papp:Look` migrate transparently in the parser (Default →
    // Auto, Neutral → Neutral), as do sidecars carrying the retired
    // `AcrMatch` (→ Auto). See raw-core::types::adjustment::Profile.
    s.push_str("export type Profile = 'Auto' | 'Neutral';\n\n");

    // Tone-curve application mode (ticket #436). `PerChannel` applies the
    // three R/G/B curves independently (hue shifts); `RatioPreserving`
    // folds them through Rec.2020 luma to preserve hue. Default is
    // `PerChannel` for backward compatibility (see
    // raw-core::stages::tone_curves).
    s.push_str("export type ToneCurveMode = 'PerChannel' | 'RatioPreserving';\n\n");

    // Master on/off for the lens corrections a DNG embeds in its
    // OpcodeList3 (#376). `On` (default) applies each family at its own
    // `lensCorrection*` scale, matching ACR when a profile is present;
    // `Off` overrides all three scales (see
    // raw-core::pipeline::pano::opcode_apply::LensCorrectionScales).
    s.push_str("export type LensProfileEnable = 'Off' | 'On';\n\n");

    // User white-balance method (ticket #431). `Cat16` performs proper
    // chromatic adaptation in CAT16 LMS cone space (default since #431);
    // `DiagonalRec2020` is the legacy von-Kries diagonal-gain path
    // retained for parity A/B (see raw-core::stages::white_balance).
    s.push_str("export type WbMethod = 'Cat16' | 'DiagonalRec2020';\n\n");

    s.push_str("export type WbSource = 'AsShot' | 'Auto' | 'Preset' | 'Sampled' | 'Manual';\n\n");

    // Per-image auto-exposure mode (ticket #429). `On` (default) anchors
    // scene mid-gray to 0.18 before AgX so every camera lands at the
    // same point on the sigmoid by default; `Off` skips anchoring for
    // strict scene-referred output. The user `exposure` slider stacks
    // additively in EV on top (see raw-core::stages::auto_exposure).
    s.push_str("export type AutoExposureMode = 'Off' | 'On';\n\n");

    // Hot/dead-pixel suppression (#1106). `Off` (default) skips the
    // pre-demosaic defect-replacement stage bit-identically; `On` replaces
    // same-color-neighbor outliers with the neighborhood median inside the
    // decode product (see raw-core::stages::hot_pixel).
    s.push_str("export type HotPixelSuppressionMode = 'Off' | 'On';\n\n");

    // Black & white conversion (#276). `On` routes the 8-band Oklab stage
    // into its monochrome path — the gray-mixer weights drive L and chroma
    // is forced to zero — and makes the 24 HSL sliders inert.
    s.push_str("export type BlackWhiteMode = 'Off' | 'On';\n\n");

    // Bayer demosaic kernel override (#3413). `Auto` (default) picks from
    // the frame's noise profile and size; the rest pin one kernel. See
    // raw-core::types::adjustment::DemosaicChoice and
    // raw-core::demosaic::policy.
    s.push_str(
        "export type DemosaicChoice = 'Auto' | 'Amaze' | 'Rcd' | 'DualAmaze' | 'DualRcd' | 'Lmmse';\n\n",
    );
}
