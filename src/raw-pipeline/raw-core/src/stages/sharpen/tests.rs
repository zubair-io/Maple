//! Tests for the sharpen stage (split out of `sharpen.rs` to satisfy the
//! file-size budget; see `tools/check-file-budget.sh`). Module semantics are
//! identical to the previous in-file `mod tests` — `super` is `stages::sharpen`.

use super::*;

/// Reference for the PRE-#1089 two-sweep form: a full `observed` clone + a
/// full `sharpened` buffer, USM scale built in one serial sweep, the edge mix
/// applied in a second sweep reading both. This is the EXACT arithmetic the
/// fused single-pass `apply` replaced. Not called by production code.
fn apply_two_sweep_reference(img: &mut Image, amount: f32, radius: f32, detail: f32, masking: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 {
        return;
    }
    let sigma = radius.clamp(0.5, 3.0);
    let (w, h) = (img.width as i32, img.height as i32);
    let (wu, hu) = (img.width as usize, img.height as usize);

    let luma: Vec<f32> = img
        .pixels
        .iter()
        .map(|p| LUMA_R * p[0] + LUMA_G * p[1] + LUMA_B * p[2])
        .collect();
    let luma_blur = gaussian_blur_plane_sigma(&luma, wu, hu, sigma);

    // Sweep 1: USM scale into a dedicated buffer, off an observed clone.
    let observed = img.pixels.clone();
    let mut sharpened: Vec<[f32; 3]> = vec![[0.0; 3]; img.pixels.len()];
    for i in 0..img.pixels.len() {
        let (o, li, lb) = (observed[i], luma[i], luma_blur[i]);
        let lo = li + (li - lb);
        let weight = smoothstep(SHADOW_EPSILON, SHADOW_BAND * SHADOW_EPSILON, li);
        let bounded = (lo / li.max(SHADOW_EPSILON)).clamp(MIN_SCALE, MAX_SCALE);
        let scale = 1.0 + weight * (bounded - 1.0);
        sharpened[i] = [o[0] * scale, o[1] * scale, o[2] * scale];
    }

    // Sweep 2: edge-aware mix.
    let overall_mix = (amount / 100.0).clamp(0.0, 1.5);
    let detail_atten = (detail / 100.0).clamp(0.0, 1.0);
    let masking_threshold = (masking / 100.0).clamp(0.0, 1.0);
    let gradient = |x: i32, y: i32| -> f32 {
        let idx =
            |xi: i32, yi: i32| (yi.clamp(0, h - 1) as usize) * wu + xi.clamp(0, w - 1) as usize;
        let gx = luma[idx(x + 1, y)] - luma[idx(x - 1, y)];
        let gy = luma[idx(x, y + 1)] - luma[idx(x, y - 1)];
        (gx * gx + gy * gy).sqrt()
    };
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let edge = if masking_threshold > 1e-3 {
                let g_norm = (gradient(x, y) / 0.2).clamp(0.0, 1.0);
                if g_norm >= masking_threshold {
                    1.0
                } else {
                    detail_atten
                }
            } else {
                1.0
            };
            let mix = overall_mix * edge;
            let (o, s) = (observed[i], sharpened[i]);
            img.pixels[i] = [
                o[0] + (s[0] - o[0]) * mix,
                o[1] + (s[1] - o[1]) * mix,
                o[2] + (s[2] - o[2]) * mix,
            ];
        }
    }
}

/// #1089 bit-identity gate: the fused single-pass `apply` must reproduce the
/// pre-#1089 two-sweep reference to the LAST BIT, across slider corners that
/// exercise every branch — masking on/off (the `gradient` path), amount
/// below/at/above 100, several radii, detail=0. A textured field (ramp +
/// impulse + coloured patch + deep-shadow pixel) keeps the USM scale, the
/// shadow guard and the edge mix all live. Equality is on the raw `f32` bit
/// patterns, so a single-ULP reordering would fail here.
#[test]
fn fused_is_bit_identical_to_two_sweep_reference() {
    let (w, h) = (37u32, 23u32); // odd dims exercise edge clamping in the gradient idx closure
    let mut base = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for y in 0..h as usize {
        for x in 0..w as usize {
            let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
            base.pixels[y * w as usize + x] =
                [0.05 + 0.9 * fx, 0.05 + 0.9 * fy, 0.05 + 0.9 * fx * fy];
        }
    }
    base.pixels[(h / 2 * w + w / 2) as usize] = [3.0, 3.0, 3.0]; // impulse → scale clamp
    base.pixels[(2 * w + 2) as usize] = [0.02, 0.6, 0.4]; // coloured patch
    base.pixels[(5 * w + 5) as usize] = [5e-5, 5e-5, 5e-5]; // deep shadow → guard ramp

    let cases: &[(f32, f32, f32, f32)] = &[
        (100.0, 1.0, 25.0, 0.0),  // canonical, masking off
        (100.0, 1.0, 25.0, 60.0), // masking on → gradient path live
        (60.0, 0.5, 40.0, 30.0),  // amount<100, narrow radius, masking on
        (130.0, 3.0, 10.0, 80.0), // amount>100, wide radius, masking on
        (40.0, 2.0, 0.0, 0.0),    // amount<100, masking off, detail=0
    ];
    for &(amount, radius, detail, masking) in cases {
        let mut fused = base.clone();
        apply(&mut fused, amount, radius, detail, masking);
        let mut reference = base.clone();
        apply_two_sweep_reference(&mut reference, amount, radius, detail, masking);
        for (i, (a, b)) in fused.pixels.iter().zip(reference.pixels.iter()).enumerate() {
            for c in 0..3 {
                assert_eq!(
                    a[c].to_bits(),
                    b[c].to_bits(),
                    "pixel {i} ch {c} differs (a={} b={}) @ amount={amount} radius={radius} \
                     detail={detail} masking={masking}",
                    a[c],
                    b[c],
                );
            }
        }
    }
}

#[test]
fn amount_zero_is_identity() {
    let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        *p = [(i % 3) as f32 * 0.3, 0.5, 0.7];
    }
    let before = img.pixels.clone();
    apply(&mut img, 0.0, 1.0, 25.0, 0.0);
    assert_eq!(img.pixels, before);
}

#[test]
fn flat_region_stays_flat_approximately() {
    // On a perfectly flat field, luma USM has luma_in == luma_blur,
    // so the unsharp delta is zero and scale = 1.0 (identity).
    let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.5, 0.5, 0.5];
    }
    apply(&mut img, 100.0, 1.0, 25.0, 0.0);
    for p in &img.pixels {
        for &c in p {
            assert!((c - 0.5).abs() < 1e-4, "{} drifted from 0.5", c);
        }
    }
}

#[test]
fn edge_becomes_sharper() {
    // A step edge should get steeper with amount=100.
    let mut img = Image::new(16, 4, ColorSpace::SceneLinearRec2020);
    for y in 0..4 {
        for x in 0..16_usize {
            img.pixels[y * 16 + x] = if x < 8 {
                [0.3, 0.3, 0.3]
            } else {
                [0.7, 0.7, 0.7]
            };
        }
    }
    let before = img.pixels.clone();
    apply(&mut img, 100.0, 1.0, 25.0, 0.0);
    let right_idx = 2 * 16 + 8; // first pixel after the edge
    let left_idx = 2 * 16 + 7; // last pixel before the edge
    assert!(
        img.pixels[right_idx][0] >= before[right_idx][0] - 0.01,
        "right side: {} vs {}",
        img.pixels[right_idx][0],
        before[right_idx][0]
    );
    assert!(
        img.pixels[left_idx][0] <= before[left_idx][0] + 0.01,
        "left side: {} vs {}",
        img.pixels[left_idx][0],
        before[left_idx][0]
    );
}

#[test]
fn preserves_scene_headroom() {
    // Above-display values must remain finite (no NaN/Inf).
    let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [5.0, 3.0, 1.5];
    }
    apply(&mut img, 100.0, 1.0, 25.0, 0.0);
    for p in &img.pixels {
        for &c in p {
            assert!(c.is_finite());
        }
    }
}

/// Regression for the test_0002 magenta-cast bug: a strongly blue-biased
/// pixel inside an otherwise mid-gray field must not have its chroma
/// ratio diverge — luma-only USM scales every channel by the SAME factor,
/// so the R:G:B ratio of the output equals the R:G:B ratio of the input.
/// Pre-fix the per-channel Richardson-Lucy update could pump B up several×
/// while leaving R/G untouched, producing a magenta cast.
#[test]
fn chroma_ratio_is_preserved() {
    let w = 16u32;
    let h = 16u32;
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    // Mid-gray field with one strongly blue pixel (R:G:B = 1:1:4).
    for p in &mut img.pixels {
        *p = [0.18, 0.18, 0.18];
    }
    let cx = (w / 2) as usize;
    let cy = (h / 2) as usize;
    let center = cy * (w as usize) + cx;
    img.pixels[center] = [0.10, 0.10, 0.40];
    apply(&mut img, 100.0, 1.0, 25.0, 0.0);

    let p = img.pixels[center];
    // Original chroma ratio: B/R = 4.0, G/R = 1.0.
    let r = p[0].max(1e-6);
    let bg_ratio = p[2] / r;
    let gr_ratio = p[1] / r;
    assert!(
        (bg_ratio - 4.0).abs() < 1e-3,
        "B/R ratio drifted from 4.0: got {}",
        bg_ratio
    );
    assert!(
        (gr_ratio - 1.0).abs() < 1e-3,
        "G/R ratio drifted from 1.0: got {}",
        gr_ratio
    );
}

/// Regression for test_0004 (Hasselblad H5D-40 ColorChecker SG): strongly
/// negative scene-linear values produced by inv(CM) projecting saturated
/// patches must not blow up the sharpened output. Luma-only USM with the
/// shadow guard clamps `weight=0` for `luma_in < epsilon`, keeping the
/// scale at 1.0 in deep shadow.
#[test]
fn negative_pixels_stay_bounded() {
    let w = 16u32;
    let h = 16u32;
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.18, 0.18, 0.18];
    }
    // One strongly negative R pixel (mimics test_0004 worst case).
    img.pixels[(h / 2 * w + w / 2) as usize] = [-0.5, 0.18, 0.18];
    apply(&mut img, 40.0, 1.0, 25.0, 0.0);
    for (i, p) in img.pixels.iter().enumerate() {
        for (c, &v) in p.iter().enumerate() {
            assert!(
                v.is_finite(),
                "pixel {} channel {} is NOT finite: {}",
                i,
                c,
                v
            );
            assert!(
                v.abs() < 5.0,
                "pixel {} channel {} blew up: {} (pre-fix this exceeded 100)",
                i,
                c,
                v
            );
        }
    }
}
