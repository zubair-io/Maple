use super::*;
use crate::LiveSession;

fn noisy(w: u32, h: u32) -> Vec<f32> {
    let mut state = 0x2545_f491_u32;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state as f32 / u32::MAX as f32 - 0.5
    };
    (0..w * h)
        .flat_map(|i| {
            let (x, y) = ((i % w) as f32 / w as f32, (i / w) as f32 / h as f32);
            let base = 0.05 + 0.4 * x * y;
            [
                base + 0.02 * next(),
                base * 0.8 + 0.02 * next(),
                base * 0.6 - 0.01 + 0.02 * next(),
                1.0,
            ]
        })
        .collect()
}

fn all_passes() -> CaptureRefinePasses {
    CaptureRefinePasses {
        chroma_prefilter: 60.0,
        deep_denoise: 40.0,
        sharpening: Some(CaptureSharpeningParams {
            strength: 0.8,
            ..CaptureSharpeningParams::default()
        }),
    }
}

#[test]
fn an_unengaged_refine_returns_the_base_without_the_gpu() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let input = noisy(64, 48);
    let before = ctx.frame_pool.borrow().alloc_count();
    let (out, usage) = capture_refine(
        &ctx,
        &input,
        (64, 48),
        &CaptureRefinePasses::default(),
        &CancelToken::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(out, input);
    assert_eq!(usage, CaptureRefineUsage::default());
    assert_eq!(ctx.frame_pool.borrow().alloc_count(), before);
}

#[test]
fn the_refine_matches_its_passes_and_releases_its_scratch() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let (w, h) = (96, 72);
    let input = noisy(w, h);
    let passes = all_passes();
    let image = GpuImage::upload(&ctx, &input, w, h);
    let chroma = ChromaPrefilterPass {
        strength: passes.chroma_prefilter,
    };
    let denoise = DeepDenoisePass {
        strength: passes.deep_denoise,
        cancel: None,
    };
    let sharpen = CaptureSharpeningPass {
        params: passes.sharpening.unwrap(),
    };
    let expected = ChainRunner::new(&ctx, &image).run_blocking(&[&chroma, &denoise, &sharpen]);

    // A live session's warm bucket must survive a refine untouched.
    let session = LiveSession::new(&ctx, &input, w, h).unwrap();
    let retained = ctx.frame_pool.borrow().retained_bytes();
    let (refined, usage) = capture_refine(&ctx, &input, (w, h), &passes, &CancelToken::new())
        .unwrap()
        .unwrap();
    assert_eq!(refined, expected, "the refine is its passes, in order");
    assert!(usage.transient_bytes > 0);
    assert_eq!(usage.image_bytes, 4 * u64::from(w * h) * 16);
    assert_eq!(ctx.frame_pool.borrow().retained_bytes(), retained);
    let next_key = NEXT_REFINE.load(Ordering::Relaxed);
    assert_eq!(ctx.frame_pool.borrow().transient_bytes(next_key - 1), 0);
    drop(session);
}

#[test]
fn a_cancelled_refine_returns_nothing() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let input = noisy(64, 48);
    let token = CancelToken::new();
    token.cancel();
    let out = capture_refine(&ctx, &input, (64, 48), &all_passes(), &token).unwrap();
    assert!(out.is_none());
    let wrong = capture_refine(
        &ctx,
        &input[4..],
        (64, 48),
        &all_passes(),
        &CancelToken::new(),
    );
    assert!(wrong.is_err());
}
