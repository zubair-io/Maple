//! Canonical monotonic version of the develop pipeline's rendered output.
//!
//! This module is the single source of truth for a question the codebase
//! answered ad-hoc for years: *when the meaning of a stored sidecar changes,
//! how does every derived artifact know it is stale?*
//!
//! [`PIPELINE_OUTPUT_VERSION`] is a monotonically increasing `u32` that stands
//! for the whole class of changes captured by ticket #1926: any change that
//! makes the develop pipeline produce different pixels for the *same*
//! `(RAW, XMP sidecar)` input. That covers two sub-cases that historically
//! shipped with no version signal at all:
//!
//! - A pixel-math change with the stored [`crate::types::AdjustmentModel`]
//!   held fixed — a new AgX LUT, a demosaic retune, a DCP colorimetry fix, a
//!   white-balance solve change. The stored numbers still mean what they
//!   meant; the pipeline just renders them differently.
//! - A *silent reinterpretation* of a stored slider value — where the same
//!   stored number now renders differently because the formula that consumes
//!   it changed. #1733 (HSL saturation moved from a hard clip to a
//!   soft-compress near the gamut hull) and #1083 (capture-sharpening radius
//!   changed from `radius.round()` to a real sigma→box-width derivation) are
//!   the motivating examples: an old stored value renders differently than
//!   when it was authored, with nothing recording the boundary.
//!
//! ## Relationship to `wb_scale_version`
//!
//! [`crate::types::WbScaleVersion`] is the *other*, richer tool for the same
//! class of problem, and the two are complementary rather than redundant. A
//! `WbScaleVersion` stamp is written into each sidecar and records the exact
//! scale a stored `crs:Temperature`/`crs:Tint` pair was authored under, so the
//! develop chain can *convert* an old value into the current frame on load and
//! preserve the authored look exactly. That per-field provenance stamp is the
//! right tool when preserving the authored look is worth the cost of writing
//! and maintaining a converter.
//!
//! `PIPELINE_OUTPUT_VERSION` is the cheaper default for every change where a
//! converter is not written (which is most of them): it does not convert
//! anything and does not preserve the pre-change look — it simply invalidates
//! every derived artifact so a fresh render replaces the stale one. As #1926
//! puts it, a version bump after the fact is still better than an indefinitely
//! silent reinterpretation. #1733 and #1083 are exactly the cases that should
//! have bumped this counter and did not; because no cache consumed a canonical
//! version yet, there was nothing for them to bump.
//!
//! ## The bump policy (the #1926 decision)
//!
//! A raw-core change increments [`PIPELINE_OUTPUT_VERSION`] by one whenever it
//! alters the pixel output of the develop pipeline for any input, or silently
//! reinterprets an already-stored `AdjustmentModel` value without a
//! load-time converter. A change that adds a new slider left at its identity
//! default (no effect on existing sidecars), fixes a non-output-visible bug, or
//! only touches an estimator used when no value is authored (as #1870's
//! As-Shot tint seed did — see #1926) does not bump it. When in doubt, bumping
//! is the safe direction: a spurious bump costs one cache miss per asset; a
//! missed bump serves stale pixels indefinitely.
//!
//! ## How it reaches the caches
//!
//! The constant is single-sourced here and emitted by the `codegen` crate
//! (`tools/codegen.sh`) into the platform mirrors —
//! `AdjustmentModel.pipelineOutputVersion` in Swift and
//! `PIPELINE_OUTPUT_VERSION` in the generated TypeScript — so the number
//! cannot drift between languages and the `codegen-drift` CI gate fails if a
//! hand edit tries to. Each rendered-output cache folds it into its cache key,
//! so that a single bump here invalidates every stale entry across Apple and Web
//! at once. Two caches key on it today: the Web Hosted thumbnail cache (#1927,
//! `MapleCacheService.THUMB_PIPELINE_VERSION`, sourced directly from the TS
//! mirror) and Apple's `RenderedPreviewCache` (#1928, which folds the Swift
//! mirror into its key alongside its `primaryMtime` component).
//!
//! On Apple the constant supersedes, going forward, the hand-maintained,
//! drift-prone per-cache version fields that predate it. Those are not
//! statics — each is a per-instance `private let` on its cache: the `UInt32`
//! `viewTransformVersion` on `RenderedPreviewCache` (a second,
//! `viewTransformVersion` on `TileManager`, was removed along with that
//! dead subsystem in #3288; a third, `rustVersion` on the disk-based
//! `DecodedBufferCache`, was removed along with that dead subsystem in
//! #2060). `RenderedPreviewCache` retains its local `viewTransformVersion` for
//! the documented bump lineage in that file, but new pipeline-output changes
//! bump this single source instead. See `docs/pipeline.md § "Pipeline output version"` for
//! the full narrative.

/// Monotonic version of the develop pipeline's rendered output. See the
/// [module docs](self) for the bump policy and the relationship to
/// [`crate::types::WbScaleVersion`].
///
/// Consumed at compile time by the `codegen` crate, which emits the Swift and
/// TypeScript mirrors that the platform rendered-output caches key on (Web thumb
/// cache #1927; Apple `RenderedPreviewCache` #1928). Bump by exactly one, in the
/// same commit as the output-changing pipeline edit.
/// Bump lineage:
/// - 1 — initial canonical epoch (#1926).
/// - 2 — `FixVignetteRadial` (DNG `OpcodeList3` id 3) is now parsed and
///   applied (#376). A RAW carrying that opcode previously rendered with
///   the correction silently skipped as an unknown id, so the same
///   `(RAW, sidecar)` pair produces different pixels. The three
///   `lens_correction_*` scales added alongside it default to full
///   strength and do not, on their own, change any output.
/// - 3 — highlight-recovery sensor ceilings include BaselineExposure (#3267),
///   so RAWs with nonzero baseline exposure are reconstructed at their actual
///   saturation level rather than using the zero-exposure thresholds.
/// - 4 — the highlights slider runs in Adobe's direction (positive brightens),
///   so every stored non-zero Highlights value renders differently.
/// - 5 — whites moved from a scene-linear gain to the AgX white-point remap
///   (#3601), so every stored non-zero Whites value renders differently.
/// - 6 — recover sensor highlights before lens gains/warps, estimate missing color
///   from all surviving channels, and use the SDK cubic lens-warp kernel (#3633).
/// - 7 — render ordered mask-group components instead of only their first
///   recognised shape; modern radial Version 2 geometry is interpreted (#3408).
/// - 8 — downscale via integer vips_reduce box staging with 64-phase Lanczos3 kernel matching sharp/libvips (#4177).
/// - 9 — tiled NLM, fixed general-kernel reseed boundaries and canonical
///   exponential lookup bits remove target/pool-dependent rounding (#4273).
/// - 10 — evaluate highlights gain in f64 for native/WASM rounding parity (#4306, #4325).
/// - 11 — guided highlight reconstruction: clipped regions wider than 7 px
///   draw chromaticity from a per-cell bilateral-weighted gather and a
///   scene-median fallback instead of collapsing to neutral (#1690).
/// - 12 — the tier-3 scene-median prior evenly decimates the whole region's
///   stride-8 samples instead of the raster-capped top strip, so large
///   frames recover the scene chromaticity, not the sky (#1690).
/// - 13 — GPU tails omit absent Auto curve and residual-LUT passes instead of
///   running identity substitutes (PR #4193); Neutral/unavailable Auto now
///   match the CPU absent-artifact tail.
/// - 14 — sharpening darkening above the amount-40 attenuation continues as a
///   positive inverse gain instead of driving positive light to zero (#4112).
/// - 15 — native highlight tiles retain full-frame scene evidence and sampling
///   phase, include complete guided-cell support, and recover highlights before
///   supported lens warps, matching the full develop order (#4378).
/// - 16 — headless develop and export entries rasterize brush masks from
///   their `papp:BrushCorrections` dabs instead of rendering them at weight 0
///   (#360).
/// - 17 — local-adjustment mask coordinates and raster layers are mapped to
///   sensor space matching EXIF orientation (#4426).
/// - 18 — the GPU live chain evaluates local-adjustment masks in the upright
///   frame on the sensor-framed Linux and Web one-shot prefixes (#4479).
/// - 19 — highlight recovery treats demosaic ripple beside a clipped channel
///   as clipped instead of as a chromaticity witness (#4582).
/// - 20 — detect sub-declared sensor saturation as the effective white level
///   (#4592), so clipped photosites below the declared WhiteLevel linearize
///   to 1.0 and reach highlight recovery.
/// - 21 — AMaZE keeps signed opposite chroma at R/B sites and uses a
///   supported constant-ratio estimate for negative directional extrapolation (#4123).
/// - 22 — AMaZE rejects a collapsed opposite-colour estimate when its
///   diagonal witnesses disagree with the centre/cardinal surface (#4596).
/// - 23 — AMaZE validates collapsed-hue support within each CFA color plane,
///   without comparing their different channel-to-green ratios (#4596).
/// - 24 — AMaZE bounds unsupported collapsed-chroma value overshoot only when
///   the centre has interpolated same-colour surface support (#4596).
/// - 25 — camera-balanced AMaZE interpolation and supported positive-chroma
///   correction (#4627); local highlight witnesses use surviving-channel
///   chromaticity weights and weighted confidence (#4628).
/// - 26 — apply declared lossy-DNG per-plane polynomial linearization and
///   use the ordinary camera white-balance path for those samples (#4629).
/// - 27 — Robertson tint is measured from the interpolated locus, matching
///   the Adobe SDK and all three language bindings (#4630).
/// - 28 — DNG HueSatMap uses independent-axis trilinear interpolation
///   instead of subdividing each cell into tetrahedra (#4631).
/// - 29 — retain chromaticity-weighted local highlight ratios while restoring
///   observation-count confidence; common weight scaling preserves the fit (#4628).
/// - 30 — positive AMaZE chroma bounds require coherent target and sampled
///   surface support, preserving value-domain correction at colour edges (#4627).
/// - 31 — AgX rolls off common highlight chroma above diffuse white while
///   preserving the existing shadow/midtone ratio response (#4635).
/// - 32 — absent noise profiles use the existing ISO fallback, and NLM keeps
///   continuous exponential tails through binary32 underflow (#4638).
/// - 33 — externally supplied film LUTs cannot contaminate the RAW-keyed
///   Auto fit; cold and warm film/no-film renders agree (#4640).
/// - 34 — monotone Hermite Auto curves and confidence-preserving residual
///   regularization remove fitted-curve banding without changing anchors (#4636).
/// - 35 — constant-preserving HSM hue interpolation keeps signed half-turns
///   from reversing under floating-point rounding; one-shot GPU renders apply
///   camera WB before nonlinear DCP and auto exposure (#4629).
/// - 36 — calibrated HueSatMap pairs for Fujifilm GFX 50S/50R and Leica M10
///   complete their existing matrix-only bundled profiles (#4645).
/// - 37 — diagonal DNG camera calibration cancels against reference-neutral
///   normalization after camera WB; do not apply its inverse twice (#4646).
/// - 38 — withdraw the experimental #4645 bundle tables after their complete
///   fixture qualification exposed regressions; retain #4646 calibration.
/// - 39 — apply required Bayer DNG gain maps and transport local sensor
///   saturation ceilings through demosaic and highlight recovery (#4647).
/// - 40 — transport gain-map saturation ceilings through the actual fitted
///   automatic lateral-CA resample, including half-size preparation (#4647).
/// - 41 — integrate main's extended-range ICC raster decoding (#4624) and
///   corrected resident GPU-prefix stage ownership with the color repairs.
///   Main shipped its ICC change as v25 independently of this branch's
///   diagnostic v25-v40 sequence; the combined output has a fresh identity.
/// - 42 — uncalibrated raster CPU/export/detail and Windows paths use unknown
///   ISO consistently with native raster GPU rendering (#4653).
/// - 43 — Catmull–Rom lens resampling reproduces affine/quadratic samples
///   and reduces negative-lobe edge ringing without scene clipping (#4650).
/// - 44 — guided dehaze transmission retains its pointwise haze fraction,
///   preventing negative reconstruction from positive observations (#4654).
/// - 45 — scene chroma operators engage compression at the soft knee, with
///   HSL continuity from zero and matching masked GPU controls (#4664).
pub const PIPELINE_OUTPUT_VERSION: u32 = 45;

#[cfg(test)]
mod tests {
    use super::PIPELINE_OUTPUT_VERSION;

    /// The version is a positive, monotonically-increasing counter — it is
    /// never zero (zero is reserved as "unset" by convention) and only ever
    /// moves upward. This guards against an accidental reset to 0, which would
    /// silently collide a fresh build's cache keys with the very first epoch.
    #[test]
    fn pipeline_output_version_is_nonzero() {
        assert!(
            PIPELINE_OUTPUT_VERSION >= 1,
            "PIPELINE_OUTPUT_VERSION must be >= 1; 0 is reserved as the unset \
             sentinel and would collide with the first canonical epoch"
        );
    }
}
