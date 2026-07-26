//! The local-adjustment FFI wire (#1698), split from
//! `scene_linear_chain_tests.rs` for the 600-LOC file budget (the same
//! `#[path]` split the `_fused_tests` sibling uses). Reuses that module's
//! `default_params` so both files describe the same neutral baseline.

use crate::scene_linear_chain::{maple_apply_scene_linear_chain_f32, MapleAdjustmentParams};
use crate::scene_linear_chain_tests::default_params;

/// The local-adjustment wire reaches the CPU chain (#1698). Two runs over the
/// same buffer — one with a NULL layer pointer, one with a hard-stepped linear
/// gradient carrying +1 EV — must agree bit-for-bit on the masked-out half and
/// differ by exactly a factor of two on the masked-in half.
///
/// This is the FFI half of the ticket: the kernel and the Rust stage are gated
/// against each other in `raw-gpu`, but neither renders anything if the layer
/// stack never crosses the boundary. The NULL run doubles as the
/// backward-compatibility proof — a host built against a pre-#1698 header
/// leaves the field zeroed and gets the old output.
#[test]
fn local_adjustment_wire_reaches_the_cpu_chain() {
    use raw_core::types::{layers_to_flat, LocalAdjustment, Mask, PartialAdjustments, Point2};

    let (w, h) = (8u32, 2u32);
    let lanes = (w * h * 4) as usize;
    let mut input = vec![0.0f32; lanes];
    for (i, px) in input.chunks_exact_mut(4).enumerate() {
        let v = 0.1 + 0.05 * i as f32;
        px.copy_from_slice(&[v, v * 0.8, v * 0.6, 1.0]);
    }

    let run = |params: &MapleAdjustmentParams| -> Vec<f32> {
        let mut out = vec![0.0f32; lanes];
        let rc = unsafe {
            maple_apply_scene_linear_chain_f32(
                input.as_ptr(),
                w,
                h,
                params as *const _,
                out.as_mut_ptr(),
            )
        };
        assert_eq!(rc, 0, "chain run failed with rc {rc}");
        out
    };

    let baseline = run(&default_params());

    // Hard step at t = 0.5 along x: with `inv_w = 1/(w-1)`, columns 0..=3 land
    // below the step (weight 0) and columns 4..=7 at or above it (weight 1).
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 0.0,
        },
        adjustments: PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    }];
    let flat = layers_to_flat(&layers);
    let mut params = default_params();
    params.local_adjustments_ptr = flat.as_ptr();
    params.local_adjustments_len = flat.len();
    let masked = run(&params);

    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            for c in 0..3 {
                let (b, m) = (baseline[i + c], masked[i + c]);
                if x < 4 {
                    assert_eq!(
                        b.to_bits(),
                        m.to_bits(),
                        "pixel ({x},{y}) channel {c} is outside the mask and must be untouched"
                    );
                } else {
                    assert!(
                        (m - b * 2.0).abs() < 1e-5,
                        "pixel ({x},{y}) channel {c}: expected {} (+1 EV), got {m}",
                        b * 2.0
                    );
                }
            }
        }
    }
}
