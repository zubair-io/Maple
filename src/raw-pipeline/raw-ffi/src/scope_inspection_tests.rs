//! Authentic CPU/Metal paired scope parity, source-pixel invariants and guards.
use crate::scene_linear_chain_fused::maple_apply_chain_and_encode_display_f32;
use crate::scene_linear_chain_tests::default_params;
use crate::scope_inspection::*;
use raw_core::types::local_adjustment::flat::layers_to_flat;
use raw_core::types::{LocalAdjustment, Mask, PartialAdjustments, SKIN_TONE_RANGE};

pub(crate) fn fixture() -> (Vec<f32>, Vec<f32>) {
    let pixels: Vec<f32> = (0..64 * 48)
        .flat_map(|i| {
            let srgb = if i % 64 < 32 {
                [0.85, 0.60, 0.45]
            } else {
                [0.05, 0.8, 0.9]
            };
            let linear = srgb.map(raw_core::view::encode::srgb_degamma);
            let rgb = raw_core::color::matrices::M_SRGB_TO_REC2020.mul_vec(linear);
            [rgb[0], rgb[1], rgb[2], 1.0]
        })
        .collect();
    let layers = layers_to_flat(&[LocalAdjustment {
        mask: Mask::Everywhere,
        range: Some(SKIN_TONE_RANGE),
        adjustments: PartialAdjustments::default(),
    }]);
    (pixels, layers)
}
#[test]
fn selected_skin_coverage_preserves_cpu_rgb_and_excludes_cyan() {
    let (input, layers) = fixture();
    let mut p = default_params();
    p.temperature = 6500.0;
    p.decoded_temperature = 6500.0;
    p.skip_agx = 1;
    p.local_adjustments_ptr = layers.as_ptr();
    p.local_adjustments_len = layers.len();
    let mut paired = vec![0.0; input.len()];
    let mut plain = vec![0.0; input.len()];
    unsafe {
        assert_eq!(
            maple_apply_chain_scope_rgba_f32(
                input.as_ptr(),
                input.len(),
                64,
                48,
                &p,
                0,
                paired.as_mut_ptr()
            ),
            0
        );
        assert_eq!(
            maple_apply_chain_and_encode_display_f32(
                input.as_ptr(),
                64,
                48,
                &p,
                plain.as_mut_ptr()
            ),
            0
        );
    }
    for (a, b) in paired.chunks_exact(4).zip(plain.chunks_exact(4)) {
        assert_eq!(&a[..3], &b[..3]);
    }
    assert!(paired
        .chunks_exact(4)
        .enumerate()
        .filter(|(i, _)| i % 64 >= 32)
        .all(|(_, p)| p[3] == 0.0));
    assert!(paired
        .chunks_exact(4)
        .enumerate()
        .filter(|(i, _)| i % 64 < 32)
        .all(|(_, p)| p[3] > 0.05));
    let (w, h, rgba) = raw_core::scope::inspection_snapshot::snapshot_scope_rgba(
        &paired,
        64,
        48,
        (0, 0, 64, 48),
        true,
    )
    .unwrap();
    let evidence = raw_core::scope::inspection::reduce_scope_evidence(&rgba, w, h, true).unwrap();
    assert_eq!(evidence.sample_count, 32 * 48);
    assert_eq!(evidence.confidence, 3);
    let (_, _, cyan) = raw_core::scope::inspection_snapshot::snapshot_scope_rgba(
        &paired,
        64,
        48,
        (32, 12, 32, 24),
        true,
    )
    .unwrap();
    assert_eq!(
        raw_core::scope::inspection::reduce_scope_evidence(&cyan, 32, 24, true)
            .unwrap()
            .sample_count,
        0
    );
}
#[test]
fn invalid_target_and_ffi_capacity_leave_outputs_untouched() {
    let (input, layers) = fixture();
    let mut p = default_params();
    p.local_adjustments_ptr = layers.as_ptr();
    p.local_adjustments_len = layers.len();
    let mut out = vec![77.0; input.len()];
    unsafe {
        assert_eq!(
            maple_apply_chain_scope_rgba_f32(
                input.as_ptr(),
                input.len(),
                64,
                48,
                &p,
                1,
                out.as_mut_ptr()
            ),
            -1
        );
    }
    unsafe {
        assert_eq!(
            maple_apply_chain_scope_rgba_f32(
                input.as_ptr(),
                input.len(),
                u32::MAX,
                u32::MAX,
                &p,
                0,
                out.as_mut_ptr()
            ),
            -1
        );
    }
    assert!(out.iter().all(|v| *v == 77.0));
    let mut evidence = MapleScopeEvidence::default();
    evidence.sample_count = 777;
    unsafe {
        assert_eq!(
            maple_scope_evidence([0u8; 3].as_ptr(), 3, 1, 1, 1, &mut evidence),
            -1
        );
    }
    assert_eq!(evidence.sample_count, 777);
}
