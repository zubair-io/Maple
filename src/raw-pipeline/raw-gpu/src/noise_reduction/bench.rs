//! Completion timing, including GPU execution and readback. Run explicitly;
//! machine-dependent performance is reported, never disguised as a CI gate.
use super::tests::{color_pass, modest_image};
use crate::{ChainRunner, GpuContext, GpuImage};
use std::time::Instant;

#[test]
#[ignore = "hardware-dependent completion benchmark; run explicitly"]
fn color_nr_completion_timing() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    for (width, height) in [(256, 256), (1500, 1000), (1920, 1280)] {
        let image = GpuImage::upload(
            &ctx,
            &modest_image(width, height),
            width as u32,
            height as u32,
        );
        let runner = ChainRunner::new(&ctx, &image);
        let pass = color_pass(25.0);
        let mut timings = Vec::new();
        for iteration in 0..8 {
            ctx.frame_pool.borrow_mut().begin_frame(1);
            let start = Instant::now();
            let output = runner.run_blocking(&[&pass]);
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            ctx.frame_pool.borrow_mut().end_frame();
            assert!(output.iter().all(|value| value.is_finite()));
            if iteration >= 2 {
                timings.push(elapsed);
            }
        }
        timings.sort_by(f64::total_cmp);
        eprintln!("NLM-COMPLETION {width}x{height} nrColor=25 median={:.3}ms max={:.3}ms samples={timings:?}", timings[3], timings[5]);
        ctx.frame_pool.borrow_mut().reset();
    }
}

/// Isolate live-stage completion from the 39 MB CPU readback in the test runner.
/// Both encoding and actual GPU completion are timed; queue submission alone is
/// never reported as a completed frame. Zero NR is the matched copy control.
#[test]
#[ignore = "hardware-dependent completion benchmark; run explicitly"]
fn color_nr_stage_completion_timing() {
    use crate::chain::Pass;
    let ctx = GpuContext::new_blocking().expect("GPU required");
    for (width, height) in [(256, 256), (1500, 1000), (1920, 1280)] {
        let image = GpuImage::upload(
            &ctx,
            &modest_image(width, height),
            width as u32,
            height as u32,
        );
        let output =
            crate::spatial::alloc_rgba(&ctx, width as u32, height as u32, "nr-bench-output");
        for amount in [0.0, 25.0] {
            let pass = color_pass(amount);
            let mut timings = Vec::new();
            for iteration in 0..10 {
                ctx.frame_pool.borrow_mut().begin_frame(1);
                let start = Instant::now();
                let mut encoder =
                    ctx.device
                        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("nr-stage-completion"),
                        });
                pass.encode(
                    &ctx,
                    &mut encoder,
                    &image.buffer,
                    &output,
                    (width as u32, height as u32),
                );
                ctx.queue.submit(Some(encoder.finish()));
                ctx.device.poll(wgpu::Maintain::Wait);
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                ctx.frame_pool.borrow_mut().end_frame();
                if iteration >= 4 {
                    timings.push(elapsed);
                }
            }
            timings.sort_by(f64::total_cmp);
            eprintln!("NLM-STAGE-COMPLETION {width}x{height} nrColor={amount} median={:.3}ms max={:.3}ms samples={timings:?}", timings[3], timings[5]);
            ctx.frame_pool.borrow_mut().reset();
        }
    }
}
