//! `maple_encode_display_f32` (#3190) — the P3-aware display-encode FFI
//! entry. Split into its own file (600-LOC budget) rather than growing
//! `scene_linear_chain_tests.rs`'s existing `maple_encode_display_srgb_f32`
//! coverage, mirroring how `scene_linear_chain_fused_tests.rs` already
//! splits out the fused entry's tests.

use crate::error::maple_last_error;
use std::ffi::CStr;

/// Same tiny helper `scene_linear_chain_tests.rs` defines locally (not
/// exported across the module split).
fn last_error_string() -> String {
    unsafe {
        let p = maple_last_error();
        if p.is_null() {
            return String::new();
        }
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

#[test]
fn encode_target_f32_null_in_ptr_returns_rc_1() {
    use crate::scene_linear_chain::maple_encode_display_f32;
    let mut out = vec![0.0f32; 4];
    let rc = unsafe { maple_encode_display_f32(std::ptr::null(), 1, 1, 1, out.as_mut_ptr()) };
    assert_eq!(rc, 1);
    assert!(last_error_string().contains("null"));
}

#[test]
fn encode_target_f32_zero_dim_returns_rc_2() {
    use crate::scene_linear_chain::maple_encode_display_f32;
    let input = vec![0.0f32; 4];
    let mut out = vec![0.0f32; 4];
    let rc = unsafe { maple_encode_display_f32(input.as_ptr(), 0, 1, 1, out.as_mut_ptr()) };
    assert_eq!(rc, 2);
    assert!(last_error_string().contains("zero dimension"));
}

/// `target_primaries = 0` must byte-match the pre-#3190
/// `maple_encode_display_srgb_f32` entry — the new param defaulting to sRGB
/// is a pure generalization.
#[test]
fn encode_target_f32_srgb_matches_legacy_srgb_entry() {
    use crate::scene_linear_chain::{maple_encode_display_f32, maple_encode_display_srgb_f32};
    let input = vec![0.0f32, 0.8, 0.0, 1.0];

    let mut legacy = vec![0.0f32; 4];
    let rc1 = unsafe { maple_encode_display_srgb_f32(input.as_ptr(), 1, 1, legacy.as_mut_ptr()) };
    assert_eq!(rc1, 0);

    let mut targeted = vec![0.0f32; 4];
    let rc2 = unsafe { maple_encode_display_f32(input.as_ptr(), 1, 1, 0, targeted.as_mut_ptr()) };
    assert_eq!(rc2, 0);

    assert_eq!(
        targeted, legacy,
        "target_primaries=0 must byte-match maple_encode_display_srgb_f32"
    );
}

/// `target_primaries = 1` (P3) must diverge from `= 0` (sRGB) on a
/// saturated wide-gamut input, and both must stay within `[0, 1]` (the
/// whole point of the Oklab gamut compression — no per-channel clip
/// artefact regardless of target).
#[test]
fn encode_target_f32_p3_differs_from_srgb_and_stays_in_gamut() {
    use crate::scene_linear_chain::maple_encode_display_f32;
    let input = vec![0.0f32, 0.8, 0.0, 1.0]; // saturated wide-gamut green (#877)

    let mut srgb = vec![0.0f32; 4];
    let rc1 = unsafe { maple_encode_display_f32(input.as_ptr(), 1, 1, 0, srgb.as_mut_ptr()) };
    assert_eq!(rc1, 0);

    let mut p3 = vec![0.0f32; 4];
    let rc2 = unsafe { maple_encode_display_f32(input.as_ptr(), 1, 1, 1, p3.as_mut_ptr()) };
    assert_eq!(rc2, 0);

    let diff = (0..3)
        .map(|c| (p3[c] - srgb[c]).abs())
        .fold(0.0_f32, f32::max);
    assert!(
        diff > 1e-3,
        "P3 and sRGB targets produced near-identical output ({diff}) — target_primaries \
         looks inert"
    );
    for c in 0..3 {
        assert!(
            p3[c] >= 0.0 && p3[c] <= 1.0,
            "P3-target channel {c} out of [0,1]: {}",
            p3[c]
        );
    }
    assert!((p3[3] - 1.0).abs() < 1e-6, "alpha must be 1.0");
}
