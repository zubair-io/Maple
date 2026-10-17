use super::*;
use crate::{ChainRunner, GpuImage};

fn spot() -> GpuRetouchSpot {
    GpuRetouchSpot {
        center: [4, 4],
        source: [2, 2],
        offset: [-2, -2],
        size: [5, 5],
        radius: 2.,
        feather: 0.5,
        opacity: 1.,
        heal_kernel: Some(vec![0.25, 0.5, 0.25]),
    }
}

#[test]
fn warm_retouch_reuses_resources_and_observes_changed_kernel_and_opacity() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let input: Vec<f32> = (0..64)
        .flat_map(|i| {
            [
                ((i * 7) % 19) as f32 / 9.,
                ((i * 11) % 23) as f32 / 7.,
                ((i * 5) % 17) as f32 / 5.,
                (i % 5) as f32 / 4.,
            ]
        })
        .collect();
    let image = GpuImage::upload(&ctx, &input, 8, 8);
    let runner = ChainRunner::new(&ctx, &image);
    let run = |spot: &GpuRetouchSpot| {
        ctx.frame_pool.borrow_mut().begin_frame(4629);
        let result = runner.run_blocking(&[&RetouchPass {
            spots: std::slice::from_ref(spot),
        }]);
        ctx.frame_pool.borrow_mut().end_frame();
        for (a, b) in input.chunks_exact(4).zip(result.chunks_exact(4)) {
            assert_eq!(a[3].to_bits(), b[3].to_bits());
        }
        assert_eq!(runner.last_readback_count(), 1);
        result
    };
    let mut spot = spot();
    let original = run(&spot);
    assert_ne!(original, input);
    let allocations = ctx.frame_pool.borrow().alloc_count();
    assert!(allocations > 0);
    assert_eq!(original, run(&spot));
    spot.opacity = 0.;
    assert_eq!(input, run(&spot));
    spot.opacity = 1.;
    assert_eq!(original, run(&spot));
    spot.heal_kernel = Some(vec![0., 1., 0.]);
    assert_eq!(input, run(&spot));
    assert_eq!(ctx.frame_pool.borrow().alloc_count(), allocations);
}

#[test]
#[should_panic(expected = "retouch patch outside frame")]
fn invalid_footprint_is_rejected_before_dispatch() {
    let mut spot = spot();
    spot.source = [1, 1];
    spot.validate((8, 8));
}

#[test]
#[should_panic(expected = "invalid retouch kernel")]
fn even_kernel_is_rejected_before_dispatch() {
    let mut spot = spot();
    spot.heal_kernel = Some(vec![0.5, 0.5]);
    spot.validate((8, 8));
}

#[test]
fn ordered_mixed_patches_reuse_scratch_across_warm_frames() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let input: Vec<_> = (0..64)
        .flat_map(|i| [((i * 7) % 19) as f32 / 9., i as f32 / 64., 0.5, 1.])
        .collect();
    let image = GpuImage::upload(&ctx, &input, 8, 8);
    let runner = ChainRunner::new(&ctx, &image);
    let spots = [
        spot(),
        GpuRetouchSpot {
            size: [3, 3],
            offset: [-1, -1],
            center: [2, 2],
            source: [4, 4],
            heal_kernel: None,
            ..spot()
        },
        spot(),
    ];
    let run = || {
        ctx.frame_pool.borrow_mut().begin_frame(4629);
        let result = runner.run_blocking(&[&RetouchPass { spots: &spots }]);
        ctx.frame_pool.borrow_mut().end_frame();
        assert_eq!(runner.last_readback_count(), 1);
        result
    };
    let first = run();
    assert_ne!(first, input);
    let allocations = ctx.frame_pool.borrow().alloc_count();
    for _ in 0..3 {
        assert_eq!(run(), first);
        assert_eq!(ctx.frame_pool.borrow().alloc_count(), allocations);
    }
}

#[test]
fn gather_two_row_dispatch_covers_each_pixel_once() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let rgba: Vec<_> = (0..640).flat_map(|i| [i as f32 + 1.; 4]).collect();
    let image = GpuImage::upload(&ctx, &rgba, 320, 2);
    let source = GpuImage::upload(&ctx, &vec![0.; 320 * 4], 320, 1);
    let destination = GpuImage::upload(&ctx, &vec![0.; 320 * 4], 320, 1);
    let spot = GpuRetouchSpot {
        center: [0, 0],
        source: [0, 1],
        offset: [0, 0],
        size: [320, 1],
        ..spot()
    };
    let pipeline = ctx.retouch_pipelines.get(&ctx, 0);
    let resources = crate::spatial::prepare_simple_dispatch(
        &ctx,
        pipeline,
        bytemuck::bytes_of(&spot.params((320, 2))),
        &[&image.buffer, &source.buffer, &destination.buffer],
        "two-row-retouch",
    );
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, resources.bind_group.as_ref(), &[]);
        pass.dispatch_workgroups(1, 2, 1);
    }
    ctx.queue.submit(Some(encoder.finish()));
    for (actual, offset) in [
        (source.read_back_blocking(&ctx), 320 * 4),
        (destination.read_back_blocking(&ctx), 0),
    ] {
        assert_eq!(&actual[..128 * 4], &rgba[offset..offset + 128 * 4]);
        assert!(actual[128 * 4..].iter().all(|v| *v == 0.));
    }
}
