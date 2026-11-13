use super::*;

struct ResetHooks;
impl Drop for ResetHooks {
    fn drop(&mut self) {
        cached::CANCEL_AT_TILE.with(|tile| tile.set(u32::MAX));
        cached::TILES_ENCODED.with(|count| count.set(0));
    }
}

fn run(ctx: &GpuContext, image: &GpuImage, token: Option<CancelToken>) -> Option<Vec<f32>> {
    let pass = DeepDenoisePass {
        strength: 50.0,
        cancel: token.clone(),
    };
    let runner = ChainRunner::new(ctx, image);
    match token {
        Some(token) => runner.run_cancellable(&[&pass], &token),
        None => Some(runner.run_blocking(&[&pass])),
    }
}

#[test]
fn bm3d_stops_at_the_next_tile_and_tile_submission_keeps_results() {
    let _reset = ResetHooks;
    let ctx = GpuContext::new_blocking().expect("GPU required");
    ctx.set_bm3d_binding_cap(1 << 20);
    // Thousands of tiles: one submission would exhaust Metal command buffers.
    let (w, h) = (640, 480);
    let input = fixture(w, h);
    let image = GpuImage::upload(&ctx, &input, w, h);

    let whole = run(&ctx, &image, None).unwrap();
    let tiled = run(&ctx, &image, Some(CancelToken::new())).unwrap();
    let tiles = cached::TILES_ENCODED.with(|count| count.replace(0));
    assert!(tiles > 4, "fixture must span several tiles, got {tiles}");
    assert_eq!(whole, tiled, "per-tile submission changed the result");

    cached::CANCEL_AT_TILE.with(|tile| tile.set(2));
    assert!(run(&ctx, &image, Some(CancelToken::new())).is_none());
    assert_eq!(cached::TILES_ENCODED.with(|count| count.replace(0)), 3);

    cached::CANCEL_AT_TILE.with(|tile| tile.set(u32::MAX));
    let cancelled = CancelToken::new();
    cancelled.cancel();
    assert!(run(&ctx, &image, Some(cancelled)).is_none());
    assert_eq!(cached::TILES_ENCODED.with(std::cell::Cell::get), 0);

    let after = run(&ctx, &image, Some(CancelToken::new())).unwrap();
    assert_eq!(whole, after, "a cancelled run disturbed the next one");
}
