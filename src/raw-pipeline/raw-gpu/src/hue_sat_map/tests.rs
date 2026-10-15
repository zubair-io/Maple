use super::*;
use crate::{ChainRunner, GpuImage};
use raw_core::color::hsm::{self, HsmEncoding, HsmTable};

fn pass(table: &HsmTable) -> HueSatMapPass<'_> {
    HueSatMapPass {
        dims: table.dims,
        srgb: table.encoding == HsmEncoding::Srgb,
        data: &table.data,
    }
}

fn input() -> Vec<f32> {
    let mut rgba = Vec::new();
    // Lattice boundaries, the circular hue seam, the achromatic fade, negative
    // ProPhoto values and unclamped scene headroom. Alpha is deliberately varied.
    for h in [
        0., 0.001, 18., 60., 119.999, 120., 180., 240., 300., 359.999,
    ] {
        for s in [0., 0.0001, 0.0049, 0.0051, 0.0099, 0.01, 0.1, 0.5, 1.] {
            for v in [0., 0.001, 0.0031308, 0.18, 0.5, 1., 4.] {
                for lift in [0., -0.04, -1.] {
                    let p = hsm::hsv_to_rgb(h, s, v);
                    rgba.extend_from_slice(&[p[0] + lift, p[1] + lift, p[2] + lift, s]);
                }
            }
        }
    }
    rgba
}

fn table(dims: [u32; 3], encoding: HsmEncoding) -> HsmTable {
    let mut data = Vec::new();
    for h in 0..dims[0] {
        for s in 0..dims[1] {
            for v in 0..dims[2] {
                // Nonseparable axes distinguish trilinear from tetrahedral and
                // catch the value-fastest storage order. Adjacent hue deltas
                // straddle +/-180 to require shortest-arc interpolation.
                let sign = if h % 2 == 0 { -1. } else { 1. };
                data.extend_from_slice(&[
                    sign * (179. - (s * v) as f32 * 0.3),
                    0.6 + ((h + 1) * (s + 1)) as f32 * 0.03,
                    0.8 + ((v + 1) * (s + 1)) as f32 * 0.02,
                ]);
            }
        }
    }
    HsmTable::new(dims, data, encoding).unwrap()
}

fn check(ctx: &GpuContext, rgba: &[f32], table: &HsmTable, label: &str) -> Vec<f32> {
    let image = GpuImage::upload(ctx, rgba, (rgba.len() / 4) as u32, 1);
    let runner = ChainRunner::new(ctx, &image);
    let output = runner.run_blocking(&[&pass(table)]);
    assert_eq!(runner.last_readback_count(), 1);
    let mut maximum = 0_f32;
    for (i, (input, result)) in rgba.chunks_exact(4).zip(output.chunks_exact(4)).enumerate() {
        let expected = hsm::apply_one([input[0], input[1], input[2]], table);
        assert_eq!(input[3].to_bits(), result[3].to_bits(), "alpha {label}/{i}");
        for c in 0..3 {
            let error = (expected[c] - result[c]).abs();
            assert!(
                error <= 1e-4,
                "{label}/{i}/{c}: input {input:?}, CPU {expected:?}, GPU {result:?}, error {error}"
            );
            maximum = maximum.max(error);
        }
    }
    eprintln!(
        "HSM {label}: {} pixels, max error {maximum:e}",
        rgba.len() / 4
    );
    output
}

#[test]
fn trilinear_hsm_matches_core_across_encoding_shape_and_scene_range() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let rgba = input();
    for dims in [[7, 4, 1], [7, 4, 5], [1, 4, 5], [7, 1, 5], [1, 1, 1]] {
        for encoding in [HsmEncoding::Linear, HsmEncoding::Srgb] {
            check(
                &ctx,
                &rgba,
                &table(dims, encoding),
                &format!("{dims:?}/{encoding:?}"),
            );
        }
    }
}

#[test]
fn half_turn_signs_and_achromatic_fade_match_core() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let rgba = input();
    for hue in [-540., -350., -180., -10., 0., 10., 180., 350., 540.] {
        let table = HsmTable::new([1, 1, 1], vec![hue, 1.4, 1.2], HsmEncoding::Linear).unwrap();
        check(&ctx, &rgba, &table, &format!("constant hue {hue}"));
    }
}

#[test]
fn repeat_hsm_reuses_resources_and_observes_changed_table_contents() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let rgba = input();
    let image = GpuImage::upload(&ctx, &rgba, (rgba.len() / 4) as u32, 1);
    let runner = ChainRunner::new(&ctx, &image);
    let mut table = table([7, 4, 5], HsmEncoding::Linear);
    let run = |table: &HsmTable| {
        ctx.frame_pool.borrow_mut().begin_frame(4629);
        let output = runner.run_blocking(&[&pass(table)]);
        ctx.frame_pool.borrow_mut().end_frame();
        output
    };
    let first = run(&table);
    let allocations = ctx.frame_pool.borrow().alloc_count();
    assert!(allocations > 0);
    assert_eq!(first, run(&table));
    assert_eq!(allocations, ctx.frame_pool.borrow().alloc_count());
    // Same Vec allocation, changed contents: pointer identity must not hide a
    // new profile table. No new GPU buffer/bind group is needed at the same size.
    for entry in table.data.chunks_exact_mut(3) {
        entry[2] *= 1.1;
    }
    let changed = run(&table);
    assert_ne!(first, changed);
    assert_eq!(allocations, ctx.frame_pool.borrow().alloc_count());
    assert_eq!(
        changed,
        check(&ctx, &rgba, &table, "changed resident table")
    );
}

#[test]
#[ignore = "requires physical camera RAW corpus and a GPU adapter"]
fn physical_camera_profile_tables_match_core() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    let rgba = input();
    let mut exercised = 0;
    for fixture in [
        "test_0000.DNG",
        "test_0002.dng",
        "test_0006.DNG",
        "test_0013.DNG",
    ] {
        let bytes = std::fs::read(root.join(fixture)).expect("required physical RAW");
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let profile = raw_core::color::dcp::profile_for(&raw).unwrap();
        if let Some(table) = profile.hsm {
            check(&ctx, &rgba, &table, fixture);
            exercised += 1;
        }
    }
    assert!(exercised >= 2, "required real tables, got {exercised}");
}
