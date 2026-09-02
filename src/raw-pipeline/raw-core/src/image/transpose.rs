//! Cache-blocked, rayon-parallel transpose for the four EXIF orientations
//! that swap width and height (`Transpose`, `Rotate90`, `Transverse`,
//! `Rotate270`). See #2486.
//!
//! The naive row-major destination scan gathers from a source index whose
//! row jumps by a full row-stride every destination pixel — at 100 MP that
//! is a cache miss per pixel (measured ~1.1 s for `Rotate90` on a 306 MB u8
//! RGB buffer, `raw-core/examples/tick-tail-bench.rs`). Tiling both
//! destination axes into `BLOCK`-sized blocks bounds the source footprint
//! touched while one block is scanned to roughly `BLOCK²` pixels — small
//! enough to stay resident in L1/L2 even though the access pattern inside a
//! block is still strided. Row-strips of blocks are then split across rayon
//! workers as disjoint, non-overlapping writes into the output buffer, so no
//! synchronization is needed beyond the split itself.
//!
//! Shared by the packed `u8`/`u16` RGB path (`image::apply_orientation`) and
//! the packed-f32 RGBA path (`pipeline::orient::apply_orientation_f32_rgba`)
//! via the `CH` const generic, so the one blocking/parallelization strategy
//! can't drift between the two.

use rayon::prelude::*;

/// Block edge length, in destination pixels. Chosen so a block's source
/// footprint (`BLOCK * BLOCK * CH` samples) comfortably fits L2 for both the
/// 3-channel `u8`/`u16` path and the 4-channel `f32` path.
const BLOCK: usize = 64;

/// Apply a transposing orientation. `src` is `sw`-wide (in `CH`-channel
/// pixels); `source_of(xp, yp)` maps a destination pixel to its source pixel
/// coordinates and must be `Sync` (it runs concurrently across row-strips).
/// `dw`/`dh` are the destination dimensions.
pub(crate) fn apply<T: Copy + Default + Send + Sync, const CH: usize>(
    src: &[T],
    sw: usize,
    dw: usize,
    dh: usize,
    source_of: impl Fn(usize, usize) -> (usize, usize) + Sync,
) -> Vec<T> {
    // `par_chunks_mut` panics on a zero chunk size, and the chunk size here
    // is `dw * CH * BLOCK` — a degenerate `dw == 0` (or `dh == 0`, which
    // makes `out` empty and the loop below a no-op either way) would panic
    // instead of just producing the empty buffer the pre-#2486 nested loop
    // silently returned for the same input (Copilot review on #3155).
    if dw == 0 || dh == 0 {
        return Vec::new();
    }
    let mut out = vec![T::default(); dw * dh * CH];
    out.par_chunks_mut(dw * CH * BLOCK)
        .enumerate()
        .for_each(|(strip_idx, strip)| {
            let yp0 = strip_idx * BLOCK;
            let strip_rows = strip.len() / (dw * CH);
            for xp_block in (0..dw).step_by(BLOCK) {
                let xp_end = (xp_block + BLOCK).min(dw);
                for local_yp in 0..strip_rows {
                    let yp = yp0 + local_yp;
                    let row = &mut strip[local_yp * dw * CH..(local_yp + 1) * dw * CH];
                    for xp in xp_block..xp_end {
                        let (sx, sy) = source_of(xp, yp);
                        let si = (sy * sw + sx) * CH;
                        let di = xp * CH;
                        row[di..di + CH].copy_from_slice(&src[si..si + CH]);
                    }
                }
            }
        });
    out
}

/// Plain row-major gather, no blocking or parallelism: the shape the reflect
/// family (`HorizontalFlip`/`Rotate180`/`VerticalFlip`) already runs at
/// good cache behaviour (each destination row reads one contiguous, possibly
/// reversed, source row), so it doesn't need `apply`'s tiling. Also the
/// correctness oracle `apply`'s tests check the blocked result against.
pub(crate) fn scan<T: Copy + Default, const CH: usize>(
    src: &[T],
    sw: usize,
    dw: usize,
    dh: usize,
    source_of: impl Fn(usize, usize) -> (usize, usize),
) -> Vec<T> {
    let mut out = vec![T::default(); dw * dh * CH];
    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = source_of(xp, yp);
            let si = (sy * sw + sx) * CH;
            let di = (yp * dw + xp) * CH;
            out[di..di + CH].copy_from_slice(&src[si..si + CH]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A degenerate zero-width or zero-height destination must return an
    /// empty buffer, not panic in `par_chunks_mut(0)` (Copilot review on
    /// #3155 — the naive pre-#2486 loop was silently safe here since `for
    /// _ in 0..0 {}` just doesn't run; the blocked/parallel path needs an
    /// explicit guard for the same input to stay just as safe).
    #[test]
    fn zero_sized_destination_returns_empty_without_panicking() {
        let src: Vec<u8> = vec![1, 2, 3];
        assert_eq!(
            apply::<u8, 3>(&src, 1, 0, 5, |xp, yp| (xp, yp)),
            Vec::<u8>::new()
        );
        assert_eq!(
            apply::<u8, 3>(&src, 1, 5, 0, |xp, yp| (xp, yp)),
            Vec::<u8>::new()
        );
        assert_eq!(
            apply::<u8, 3>(&src, 1, 0, 0, |xp, yp| (xp, yp)),
            Vec::<u8>::new()
        );
    }

    /// Sizes that straddle the block boundary on both axes, so the last
    /// (partial) row-strip and the last (partial) column-block both get
    /// exercised.
    #[test]
    fn matches_naive_reference_across_block_boundaries() {
        for (sw, sh) in [(1usize, 1usize), (63, 65), (64, 64), (65, 63), (200, 130)] {
            let (dw, dh) = (sh, sw); // a transposing map: dims swap
            let src: Vec<u8> = (0..sw * sh * 3).map(|i| (i % 251) as u8).collect();
            let map = |xp: usize, yp: usize| (yp, xp); // Transpose mapping
            let got = apply::<u8, 3>(&src, sw, dw, dh, map);
            let want = scan::<u8, 3>(&src, sw, dw, dh, map);
            assert_eq!(got, want, "mismatch at sw={sw} sh={sh}");
        }
    }

    /// Four channels (the f32 RGBA shape), non-square, non-block-aligned,
    /// using the `Rotate90` mapping rather than plain `Transpose` so both
    /// index terms (`yp` and `sh - 1 - xp`) get exercised.
    #[test]
    fn four_channel_matches_naive_reference() {
        let (sw, sh) = (130usize, 90usize);
        let (dw, dh) = (sh, sw);
        let src: Vec<f32> = (0..sw * sh * 4).map(|i| i as f32 * 0.001).collect();
        let map = |xp: usize, yp: usize| (yp, sh - 1 - xp);
        let got = apply::<f32, 4>(&src, sw, dw, dh, map);
        let want = scan::<f32, 4>(&src, sw, dw, dh, map);
        assert_eq!(got, want);
    }
}
