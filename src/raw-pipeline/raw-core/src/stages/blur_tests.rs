//! Unit tests for [`super`] — the separable-blur / guided-filter
//! primitives (`box_blur_channel`, `box_blur_into`, `gaussian_blur_*`,
//! `guided_filter`). Split out of `blur.rs` under the 600-LOC file-size
//! budget (#1089 added the scratch-arena byte-identity proofs, which
//! pushed the inline module over). Same `#[path]` split the `nlm` and
//! `sharpen` stages use; contents moved verbatim, `super` is
//! `stages::blur`.

use super::*;

#[test]
fn blur_of_constant_is_constant() {
    let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.5, 0.7];
    }
    let blurred = gaussian_blur_rgb(&img, 5);
    for p in &blurred.pixels {
        assert!((p[0] - 0.3).abs() < 1e-5);
        assert!((p[1] - 0.5).abs() < 1e-5);
        assert!((p[2] - 0.7).abs() < 1e-5);
    }
}

#[test]
fn blur_smooths_a_delta() {
    // Single bright pixel should diffuse across the blur radius.
    let mut img = Image::new(21, 21, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.0; 3];
    }
    img.pixels[10 * 21 + 10] = [1.0, 1.0, 1.0];
    let blurred = gaussian_blur_rgb(&img, 3);
    // Center should be much less than 1 (energy spread out).
    let center = blurred.pixels[10 * 21 + 10][0];
    assert!(center < 0.5, "center still bright: {}", center);
    // Neighbor should have non-zero value (energy diffused).
    let neighbor = blurred.pixels[10 * 21 + 12][0];
    assert!(neighbor > 0.0);
}

#[test]
fn radius_zero_is_identity() {
    let mut img = Image::new(3, 3, ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        *p = [i as f32, i as f32 * 2.0, i as f32 * 3.0];
    }
    let before = img.pixels.clone();
    let after = gaussian_blur_rgb(&img, 0);
    for (a, b) in after.pixels.iter().zip(before.iter()) {
        assert_eq!(a, b);
    }
}

#[test]
fn blur_asymmetric_horizontal_stripe_preserves_axis() {
    // A single bright horizontal stripe on a wide-short image. After
    // a box blur, energy must spread *vertically* (because the stripe
    // is already uniform horizontally) and leave the horizontal
    // profile untouched within the row. An axis-swap in the vertical
    // sweep (e.g. reading column-major data as row-major during the
    // transpose) would shift energy into the wrong axis.
    let w = 40;
    let h = 10;
    let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.0; 3];
    }
    // Stripe at row 5, all columns.
    for x in 0..w {
        img.pixels[5 * w + x] = [1.0, 0.0, 0.0];
    }

    let blurred = gaussian_blur_rgb(&img, 3);

    // Every row in [0..h] has the same value at every column (the
    // stripe was uniform horizontally). Check this by picking two
    // arbitrary columns on row 4 and asserting they agree.
    for row in 0..h {
        let left = blurred.pixels[row * w + 3][0];
        let right = blurred.pixels[row * w + (w - 3)][0];
        assert!(
            (left - right).abs() < 1e-5,
            "row {}: left={}, right={} (horizontal profile should be uniform)",
            row,
            left,
            right
        );
    }

    // Row 5 (the stripe) must have the max response; rows 0 and h-1
    // must have less. This locks the vertical axis of the sweep.
    let stripe = blurred.pixels[5 * w][0];
    let top_row = blurred.pixels[0 * w][0];
    let bot_row = blurred.pixels[(h - 1) * w][0];
    assert!(
        stripe > top_row,
        "stripe row not brightest: stripe={}, top={}",
        stripe,
        top_row
    );
    assert!(
        stripe > bot_row,
        "stripe row not brightest: stripe={}, bot={}",
        stripe,
        bot_row
    );
}

#[test]
fn guided_filter_of_constants_is_constant() {
    // Edge-preserving filter on a flat input collapses to the
    // input — no halo, no drift.
    let guide = vec![0.5f32; 40 * 40];
    let p = vec![0.7f32; 40 * 40];
    let out = guided_filter(&guide, &p, 40, 40, GuidedOptions { r: 5, eps: 1e-3 });
    assert!(out.iter().all(|v| (*v - 0.7).abs() < 1e-4));
}

#[test]
fn self_guided_preserves_sharp_edge() {
    // Self-guided (guide == p) keeps a hard step edge sharp.
    // A plain box blur would smear it across `2r+1` pixels; the
    // guided filter should leave the step almost intact when eps
    // is small.
    let w = 32usize;
    let h = 8usize;
    let mut p = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            p[y * w + x] = if x < w / 2 { 0.2 } else { 0.8 };
        }
    }
    let out = guided_filter(&p, &p, w, h, GuidedOptions { r: 4, eps: 1e-4 });
    // Far from the edge, output equals input.
    for y in 0..h {
        assert!(
            (out[y * w + 1] - 0.2).abs() < 1e-3,
            "left side drifted at row {}: {}",
            y,
            out[y * w + 1]
        );
        assert!(
            (out[y * w + (w - 2)] - 0.8).abs() < 1e-3,
            "right side drifted at row {}: {}",
            y,
            out[y * w + (w - 2)]
        );
    }
    // Edge transition: the two pixels straddling the step retain
    // most of the contrast (≥ 0.5 of the original 0.6 gap), which
    // a Gaussian at radius 4 would not.
    let edge_left = out[3 * w + (w / 2 - 1)];
    let edge_right = out[3 * w + (w / 2)];
    assert!(
        edge_right - edge_left > 0.3,
        "edge contrast collapsed: {} -> {}",
        edge_left,
        edge_right
    );
}

/// #1088 — the negative-variance clamp's regime: scene-linear luma
/// ≫ 1, where the `mean_ii - mean_i²` cancellation runs at the same
/// magnitude as `eps` and box-mean roundoff can drive the computed
/// variance negative. On a flat bright plane the guided filter must
/// stay (a) finite and (b) within a tight relative band of the input
/// — a sign-flipped `var_i + eps` denominator violates both. This
/// pins the invariant; the clamp itself is structurally provable
/// (variance is a square, physically ≥ 0).
#[test]
fn self_guided_flat_bright_plane_stays_flat_and_finite() {
    let w = 64usize;
    let h = 64usize;
    // Non-round value so the box-blur accumulators actually round.
    let level = 3000.7f32;
    let p = vec![level; w * h];
    let out = guided_filter(&p, &p, w, h, GuidedOptions { r: 5, eps: 1e-3 });
    for (i, &v) in out.iter().enumerate() {
        assert!(v.is_finite(), "index {} non-finite: {}", i, v);
        assert!(
            (v - level).abs() / level < 1e-2,
            "index {} drifted off the flat {}: {}",
            i,
            level,
            v
        );
    }
}

#[test]
fn self_guided_local_mean_does_not_overshoot() {
    // Property that drives #264 / #265: on a dark blob in a bright
    // field the self-guided base never exceeds the field's
    // brightness. A Gaussian blur of the same plane *would*
    // produce values outside the input range only via accumulated
    // float error, but in practice the unsharp-mask combine step
    // is what generates the overshoot. Here we just check the GF
    // produces nothing outside [min(p), max(p)] up to f32 noise.
    let w = 24usize;
    let h = 24usize;
    let mut p = vec![0.8f32; w * h];
    for y in 8..16 {
        for x in 8..16 {
            p[y * w + x] = 0.2;
        }
    }
    let out = guided_filter(&p, &p, w, h, GuidedOptions { r: 3, eps: 1e-3 });
    for &v in &out {
        assert!(
            v >= 0.2 - 1e-3 && v <= 0.8 + 1e-3,
            "guided output out of input range: {}",
            v
        );
    }
}

/// Pre-arena reference implementation of `guided_filter` — the exact
/// fresh-`Vec`-per-pass form that shipped before #1089 item 7 (six
/// owning `box_blur_channel` calls under `rayon::join`, a `.collect()`
/// unzip for `a`/`b`, and a `.collect()` final combine). Kept ONLY as
/// the byte-identity oracle for the arena rewrite below; not used by
/// production code. If the arena version ever diverges by even one ULP
/// the `guided_filter_arena_matches_owning_box_blur_*` tests fail.
fn guided_filter_reference(
    guide: &[f32],
    p: &[f32],
    w: usize,
    h: usize,
    r: usize,
    eps: f32,
) -> Vec<f32> {
    assert_eq!(guide.len(), p.len());
    let n = guide.len();
    if r == 0 {
        return p.to_vec();
    }
    let ip: Vec<f32> = guide
        .par_iter()
        .zip(p.par_iter())
        .map(|(&a, &b)| a * b)
        .collect();
    let ii: Vec<f32> = guide.par_iter().map(|&a| a * a).collect();
    let ((mean_i, mean_p), (mean_ip, mean_ii)) = rayon::join(
        || {
            rayon::join(
                || box_blur_channel(guide, w, h, r),
                || box_blur_channel(p, w, h, r),
            )
        },
        || {
            rayon::join(
                || box_blur_channel(&ip, w, h, r),
                || box_blur_channel(&ii, w, h, r),
            )
        },
    );
    let (a, b): (Vec<f32>, Vec<f32>) = (0..n)
        .into_par_iter()
        .map(|i| {
            let cov_ip = mean_ip[i] - mean_i[i] * mean_p[i];
            let var_i = (mean_ii[i] - mean_i[i] * mean_i[i]).max(0.0);
            let a_i = cov_ip / (var_i + eps);
            let b_i = mean_p[i] - a_i * mean_i[i];
            (a_i, b_i)
        })
        .unzip();
    let (mean_a, mean_b) = rayon::join(
        || box_blur_channel(&a, w, h, r),
        || box_blur_channel(&b, w, h, r),
    );
    (0..n)
        .into_par_iter()
        .map(|i| mean_a[i] * guide[i] + mean_b[i])
        .collect()
}

/// Build a deterministic structured plane (sinusoids at two scales + a
/// diagonal step) — genuine high-frequency content so the guided
/// filter's edge-aware path is exercised, not a flat short-circuit.
fn structured_plane(w: usize, h: usize, scale: f32, bias: f32) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let xf = x as f32;
            let yf = y as f32;
            let lo = 0.5 + 0.35 * (xf / w as f32 * 11.0).sin() * (yf / h as f32 * 7.0).cos();
            let hi = 0.08 * (xf * 0.37).sin() * (yf * 0.41).cos();
            let edge = if x + y > (w + h) / 2 { 0.12 } else { -0.12 };
            v[y * w + x] = (lo + hi + edge) * scale + bias;
        }
    }
    v
}

/// Byte-identity: the arena `guided_filter` must produce bit-for-bit
/// the same f32 output as the pre-arena owning reference, at BOTH the
/// clarity radius (20) and the texture radius (2), on structured input.
/// This is the perf-only invariant for #1089 item 7 — the allocation
/// cut must not move a single output bit.
#[test]
fn guided_filter_arena_matches_owning_box_blur_clarity_radius() {
    // A few non-square sizes so the w≠h transpose path is covered, and
    // sizes both above and around 2*radius so border handling matters.
    for &(w, h) in &[(64usize, 48usize), (100, 70), (45, 64)] {
        let guide = structured_plane(w, h, 1.0, 0.0);
        // Self-guided, like clarity/texture: guide == p.
        let arena = guided_filter(&guide, &guide, w, h, GuidedOptions { r: 20, eps: 1e-3 });
        let reference = guided_filter_reference(&guide, &guide, w, h, 20, 1e-3);
        assert_eq!(arena.len(), reference.len());
        for i in 0..arena.len() {
            assert_eq!(
                arena[i].to_bits(),
                reference[i].to_bits(),
                "radius=20 size={}x{} index {} differs: arena={} reference={}",
                w,
                h,
                i,
                arena[i],
                reference[i]
            );
        }
    }
}

#[test]
fn guided_filter_arena_matches_owning_box_blur_texture_radius() {
    for &(w, h) in &[(64usize, 48usize), (100, 70), (45, 64)] {
        let guide = structured_plane(w, h, 1.0, 0.0);
        let arena = guided_filter(&guide, &guide, w, h, GuidedOptions { r: 2, eps: 1e-3 });
        let reference = guided_filter_reference(&guide, &guide, w, h, 2, 1e-3);
        for i in 0..arena.len() {
            assert_eq!(
                arena[i].to_bits(),
                reference[i].to_bits(),
                "radius=2 size={}x{} index {} differs: arena={} reference={}",
                w,
                h,
                i,
                arena[i],
                reference[i]
            );
        }
    }
}

/// Byte-identity in the cross-guided (`guide != p`) regime too — the
/// shared `guided_filter` is also reachable that way (dehaze ships its
/// own copy, but the primitive must stay general). Scene-linear values
/// ≫ 1 stress the variance-cancellation path the #1088 clamp guards.
#[test]
fn guided_filter_arena_matches_owning_box_blur_cross_guided_bright() {
    let (w, h) = (80usize, 56usize);
    let guide = structured_plane(w, h, 3000.0, 50.0); // bright, cross-guided
    let p = structured_plane(w, h, 1.0, 0.1);
    let arena = guided_filter(&guide, &p, w, h, GuidedOptions { r: 20, eps: 1e-3 });
    let reference = guided_filter_reference(&guide, &p, w, h, 20, 1e-3);
    for i in 0..arena.len() {
        assert_eq!(
            arena[i].to_bits(),
            reference[i].to_bits(),
            "cross-guided index {} differs: arena={} reference={}",
            i,
            arena[i],
            reference[i]
        );
    }
}

/// `box_blur_into` (the scratch core) must be byte-identical to the
/// owning `box_blur_channel` it backs — guards the shared primitive
/// every other blur caller (guided.rs, scene_tone, gaussian_*) relies
/// on, across radii and a non-square shape.
#[test]
fn box_blur_into_matches_owning_box_blur_channel() {
    let (w, h) = (70usize, 50usize);
    let src = structured_plane(w, h, 1.0, 0.0);
    for &r in &[1usize, 2, 7, 20] {
        let owning = box_blur_channel(&src, w, h, r);
        let mut dst = vec![0.0f32; w * h];
        let mut tr = vec![0.0f32; w * h];
        let mut tc = vec![0.0f32; w * h];
        box_blur_into(&src, &mut dst, &mut tr, &mut tc, w, h, r);
        for i in 0..dst.len() {
            assert_eq!(
                dst[i].to_bits(),
                owning[i].to_bits(),
                "r={} index {} differs: into={} owning={}",
                r,
                i,
                dst[i],
                owning[i]
            );
        }
    }
}
