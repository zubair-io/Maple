//! #4738 (a): the parametric tone curve (regions + splits) rides
//! `MapleToneCurves` and `wb_method` rides the params tail. Purely additive
//! ABI; the Apple wiring is (b).

use crate::error::maple_last_error;
use crate::scene_linear_chain_tests::default_params;
use std::ffi::CStr;
#[test]
fn wb_method_params_field_selects_the_rec2020_diagonal_gains() {
    use raw_core::types::WbMethod;
    let mut p = default_params();
    p.wb_method = 1;
    let diagonal = unsafe { crate::scene_linear_chain::chain_inputs_from_params(&p) };
    assert_eq!(diagonal.model.wb_method, WbMethod::DiagonalRec2020);
    p.wb_method = 0;
    let cat16 = unsafe { crate::scene_linear_chain::chain_inputs_from_params(&p) };
    assert_eq!(cat16.model.wb_method, WbMethod::Cat16);
    // Anything a newer host might send that this build does not know is the
    // default, never a crash.
    p.wb_method = 99;
    let unknown = unsafe { crate::scene_linear_chain::chain_inputs_from_params(&p) };
    assert_eq!(unknown.model.wb_method, WbMethod::Cat16);
}

fn ramp_rgba(width: u32) -> Vec<f32> {
    (0..width)
        .flat_map(|x| {
            let v = (x as f32 + 0.5) / width as f32;
            [v, v * 0.8, v * 0.6, 1.0]
        })
        .collect()
}

unsafe fn encode_with_curves(
    curves: &crate::scene_linear_chain_curves::MapleToneCurves,
) -> Vec<f32> {
    use crate::scene_linear_chain_curves::maple_apply_chain_and_encode_display_curves_f32;
    let width = 64;
    let input = ramp_rgba(width);
    let mut out = vec![0.0f32; input.len()];
    let p = default_params();
    let rc = maple_apply_chain_and_encode_display_curves_f32(
        input.as_ptr(),
        width,
        1,
        &p,
        curves,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, 0, "{:?}", unsafe { CStr::from_ptr(maple_last_error()) });
    out
}

fn identity_curves() -> crate::scene_linear_chain_curves::MapleToneCurves {
    // Every pointer null / len 0 = identity; every new tail field 0 = absent.
    unsafe { std::mem::zeroed() }
}

#[test]
fn parametric_regions_in_tone_curves_reach_the_chain() {
    let baseline = unsafe { encode_with_curves(&identity_curves()) };
    let mut lifted = identity_curves();
    lifted.parametric_highlights = 80.0;
    lifted.parametric_shadows = -60.0;
    let adjusted = unsafe { encode_with_curves(&lifted) };
    assert_ne!(
        baseline, adjusted,
        "parametric regions handed over the ABI must change the render"
    );
}

#[test]
fn parametric_splits_all_zero_mean_the_acr_defaults() {
    let mut implicit = identity_curves();
    implicit.parametric_highlights = 80.0;
    let mut explicit = identity_curves();
    explicit.parametric_highlights = 80.0;
    explicit.parametric_shadow_split = 25.0;
    explicit.parametric_midtone_split = 50.0;
    explicit.parametric_highlight_split = 75.0;
    let a = unsafe { encode_with_curves(&implicit) };
    let b = unsafe { encode_with_curves(&explicit) };
    assert_eq!(
        a, b,
        "a zero-initialised split trio (older host) is the 25/50/75 default"
    );
    let mut shifted = explicit;
    shifted.parametric_midtone_split = 30.0;
    let c = unsafe { encode_with_curves(&shifted) };
    assert_ne!(b, c, "a real split position must move the regions");
}
