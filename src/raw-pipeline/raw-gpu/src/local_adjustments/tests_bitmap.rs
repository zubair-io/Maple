//! `Mask::Bitmap` / `Mask::Everywhere` parity tests (#3271). Split out of
//! `tests.rs` to keep that file under the 600-LOC budget — same rationale as
//! that file's own split from `local_adjustments.rs`. Reaches the parent
//! module through `super::*` (for `GpuContext` and friends) and the sibling
//! `tests` module's shared harness through an explicit `use`: a sibling
//! module's items aren't visible via a glob import the way an ancestor's
//! are, so `tests`'s helpers are `pub(super)` specifically so this file (and
//! any other sibling) can name them.

use super::tests::{all_controls, buffer_16x12, max_abs_diff, only, raw_core_local, run_gpu};
use super::*;
use raw_core::types::{LocalAdjustment, Mask, MaskRaster};
use std::sync::Arc;

/// 8x6 raster, weight 1 above the diagonal, 0 below, 0.5 on it — exercises
/// bilinear interpolation between texel centres at the 16x12 render size.
fn diagonal_raster(id: u32) -> Arc<MaskRaster> {
    let (w, h) = (8u32, 6u32);
    let bytes: Vec<u8> = (0..h)
        .flat_map(|y| {
            (0..w).map(move |x| {
                if x * h > y * w {
                    255
                } else if x * h == y * w {
                    128
                } else {
                    0
                }
            })
        })
        .collect();
    Arc::new(MaskRaster::from_u8(id, "0123456789abcdef", w, h, &bytes))
}

/// `Mask::Bitmap` and `Mask::Everywhere` (#3271) against the real Rust stage:
/// a resolved bitmap raster (plain and combined with the skin-tone range
/// refinement, the epic's own scenario), an UNRESOLVED bitmap (raster id
/// with no match — must be inert, never a silent global correction), and
/// `Everywhere`.
#[test]
fn wgsl_bitmap_and_everywhere_masks_match_raw_core_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    let rasters = vec![diagonal_raster(5)];

    let cases: Vec<(&str, LocalAdjustment)> = vec![
        (
            "bitmap/exposure",
            LocalAdjustment {
                mask: Mask::Bitmap {
                    recipe: Default::default(),
                    raster_id: 5,
                },
                range: None,
                adjustments: only(|a| a.exposure = Some(1.0)),
            },
        ),
        (
            "bitmap+skin-range/hue",
            LocalAdjustment {
                mask: Mask::Bitmap {
                    recipe: Default::default(),
                    raster_id: 5,
                },
                range: Some(raw_core::types::SKIN_TONE_RANGE),
                adjustments: only(|a| a.hue = Some(80.0)),
            },
        ),
        (
            "bitmap-unresolved/inert",
            LocalAdjustment {
                mask: Mask::Bitmap {
                    recipe: Default::default(),
                    raster_id: 42,
                },
                range: None,
                adjustments: only(|a| a.exposure = Some(2.0)),
            },
        ),
        (
            "everywhere/saturation",
            LocalAdjustment {
                mask: Mask::Everywhere,
                range: None,
                adjustments: only(|a| a.saturation = Some(60.0)),
            },
        ),
    ];
    for (name, layer) in cases {
        let layers = [layer];
        let reference = raw_core_local(&input, w, h, &layers, &rasters);
        let gpu = run_gpu(&ctx, &input, w, h, &layers, &rasters);
        let diff = max_abs_diff(&reference, &gpu);
        eprintln!("PARITY vs raw-core local_adjustments [{name}]: max abs diff = {diff:e}");
        assert!(
            diff < 1e-4,
            "{name}: GPU vs raw-core stage max abs diff {diff} exceeds 1e-4"
        );
    }
}

/// An unresolved bitmap mask (no registered raster) really is a no-op, not
/// merely "close": zero weight everywhere means the buffer must come through
/// bit-exact, the same guarantee `zero_weight_region_is_bit_exact` pins for
/// a hard-stepped linear mask.
#[test]
fn bitmap_mask_with_no_registered_raster_is_bit_exact_passthrough() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    let layers = [LocalAdjustment {
        mask: Mask::Bitmap {
            recipe: Default::default(),
            raster_id: 9,
        },
        range: None,
        adjustments: all_controls(),
    }];
    let gpu = run_gpu(&ctx, &input, w, h, &layers, &[]);
    assert_eq!(
        gpu, input,
        "an unresolved bitmap mask must not touch a single pixel"
    );
}
