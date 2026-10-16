use super::*;
use crate::{ChainRunner, GpuImage};

const IDENTITY: [[f32; 3]; 3] = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];

#[test]
fn camera_gain_precedes_row_major_matrix_and_uniform_lift() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let pass = DcpColorimetryPass {
        camera_gain: [2., 1., 0.5],
        entry: [[1., -2., 0.5], [0.1, 1., -0.2], [0., 0.3, 1.]],
        // Must be ignored on the folded, no-HSM branch.
        exit: [[0.; 3]; 3],
        hsm: None,
        hsm_blend: None,
    };
    let input = [0.2, 0.8, 0.6, 0.25, 4., 2., 1., 0.75];
    let image = GpuImage::upload(&ctx, &input, 2, 1);
    let runner = ChainRunner::new(&ctx, &image);
    let output = runner.run_blocking(&[&pass]);
    assert_eq!(runner.last_readback_count(), 1);
    for (i, (before, after)) in input
        .chunks_exact(4)
        .zip(output.chunks_exact(4))
        .enumerate()
    {
        let rgb = std::array::from_fn(|c| before[c] * pass.camera_gain[c]);
        let rgb = raw_core::math::Matrix3(pass.entry).mul_vec(rgb);
        let lift = -rgb.into_iter().fold(0., f32::min);
        for c in 0..3 {
            assert!((after[c] - (rgb[c] + lift)).abs() < 1e-5, "pixel {i}/{c}");
        }
        assert_eq!(before[3].to_bits(), after[3].to_bits());
    }
    assert!(output[4] > 1., "HDR headroom must survive");
}

#[test]
fn repeated_uniform_and_table_changes_reuse_gpu_resources() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let input = [0.8, 0.4, 0.1, 0.5, -0.2, 0.1, 3., 0.75];
    let image = GpuImage::upload(&ctx, &input, 2, 1);
    let runner = ChainRunner::new(&ctx, &image);
    let mut table = [10., 0.8, 1.1];
    let run = |table: &[f32], gain: f32| {
        let pass = DcpColorimetryPass {
            camera_gain: [gain, 1., 1.],
            entry: IDENTITY,
            exit: IDENTITY,
            hsm: Some(HueSatMapPass {
                dims: [1; 3],
                srgb: false,
                data: table,
            }),
            hsm_blend: None,
        };
        ctx.frame_pool.borrow_mut().begin_frame(4629);
        let result = runner.run_blocking(&[&pass]);
        ctx.frame_pool.borrow_mut().end_frame();
        result
    };
    let first = run(&table, 1.);
    let allocations = ctx.frame_pool.borrow().alloc_count();
    assert!(allocations > 0);
    assert_eq!(first, run(&table, 1.));
    assert_ne!(first, run(&table, 2.));
    table[2] = 0.7;
    assert_ne!(first, run(&table, 1.));
    assert_eq!(allocations, ctx.frame_pool.borrow().alloc_count());
    assert_eq!(runner.last_readback_count(), 1);
}

#[test]
#[should_panic(expected = "invalid HueSatMap table length")]
fn malformed_table_cannot_reach_gpu_dispatch() {
    let table = HueSatMapPass {
        dims: [2, 2, 2],
        srgb: false,
        data: &[0.; 3],
    };
    table.validate();
}

#[test]
fn white_point_weights_reuse_tables_and_match_cpu_circular_interpolation() {
    use raw_core::color::hsm::{self, HsmEncoding, HsmTable};
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let input = [0.8, 0.4, 0.1, 0.5, -0.2, 0.1, 3., 0.75];
    let image = GpuImage::upload(&ctx, &input, 2, 1);
    let runner = ChainRunner::new(&ctx, &image);
    let cold = HsmTable::new(
        [2, 2, 1],
        vec![170., 0.8, 1.1, -170., 1.2, 0.8, 10., 1., 1., 0., 0.9, 0.7],
        HsmEncoding::Linear,
    )
    .unwrap();
    let warm = HsmTable::new(
        [2, 2, 1],
        vec![-170., 1.1, 0.9, 170., 0.9, 1.2, 0., 1., 1., 10., 1.1, 0.9],
        HsmEncoding::Linear,
    )
    .unwrap();
    let mut allocations = None;
    // Start with the resolved As Shot table, then move into and out of
    // selected-white interpolation. The first slider move must not allocate
    // a second table slot that opening the image failed to prepare.
    for selection in [
        None,
        Some(0.),
        Some(0.25),
        Some(0.5),
        Some(0.75),
        Some(1.),
        None,
    ] {
        let weight = selection.unwrap_or(0.0);
        let pass = DcpColorimetryPass {
            camera_gain: [1.; 3],
            entry: IDENTITY,
            exit: IDENTITY,
            hsm: Some(HueSatMapPass {
                dims: cold.dims,
                srgb: false,
                data: &cold.data,
            }),
            hsm_blend: selection.map(|weight| (warm.data.as_slice(), weight)),
        };
        ctx.frame_pool.borrow_mut().begin_frame(4633);
        let actual = runner.run_blocking(&[&pass]);
        ctx.frame_pool.borrow_mut().end_frame();
        let count = ctx.frame_pool.borrow().alloc_count();
        assert_eq!(*allocations.get_or_insert(count), count);
        let blended = hsm::lerp_tables(&cold, &warm, weight).unwrap();
        for (before, after) in input.chunks_exact(4).zip(actual.chunks_exact(4)) {
            let expected = hsm::apply_one([before[0], before[1], before[2]], &blended);
            let lift = -expected.into_iter().fold(0., f32::min);
            for c in 0..3 {
                assert!((after[c] - expected[c] - lift).abs() < 1e-4);
            }
            assert_eq!(before[3].to_bits(), after[3].to_bits());
        }
    }
}
