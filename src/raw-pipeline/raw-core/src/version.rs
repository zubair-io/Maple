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
//! `viewTransformVersion` on `RenderedPreviewCache`, `rustVersion` on
//! `DecodedBufferCache`, and `viewTransformVersion` on `TileManager`.
//! `RenderedPreviewCache` retains its local `viewTransformVersion` for the
//! documented bump lineage in that file, but new pipeline-output changes bump
//! this single source instead. See `docs/pipeline-output-version.md` for the
//! full narrative.

/// Monotonic version of the develop pipeline's rendered output. See the
/// [module docs](self) for the bump policy and the relationship to
/// [`crate::types::WbScaleVersion`].
///
/// Consumed at compile time by the `codegen` crate, which emits the Swift and
/// TypeScript mirrors that the platform rendered-output caches key on (Web thumb
/// cache #1927; Apple `RenderedPreviewCache` #1928). Bump by exactly one, in the
/// same commit as the output-changing pipeline edit.
pub const PIPELINE_OUTPUT_VERSION: u32 = 1;

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
