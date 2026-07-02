//! Chroma-fringing + radius-shape tests for the sharpen stage, split out of
//! `tests.rs` under the 600-LOC file-size budget. Carries the "broken"
//! per-channel reference implementation its negative-case proof drives.
//! Module semantics are identical — `super` is `stages::sharpen`.

use super::*;

/// "Broken" reference implementation: per-channel unsharp instead of
/// luma-scaled. Mirrors the pre-#439 RGB unsharp pattern — each channel
/// gets its own blur and its own delta — which produces chroma fringing
/// on coloured edges (the failure mode this stage was rewritten to
/// eliminate). Used by `broken_per_channel_reference_does_drift_chroma`
/// below to prove the no-chroma-drift assertions in the real test would
/// fire on a regression to per-channel. Not called by production code.
fn apply_broken_per_channel(img: &mut Image, amount: f32, radius: f32, detail: f32, masking: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 {
        return;
    }
    let sigma = radius.clamp(0.5, 3.0);
    let w = img.width as usize;
    let h = img.height as usize;

    // Per-channel blur — every channel gets its own Gaussian.
    let planes: [Vec<f32>; 3] = [
        img.pixels.iter().map(|p| p[0]).collect(),
        img.pixels.iter().map(|p| p[1]).collect(),
        img.pixels.iter().map(|p| p[2]).collect(),
    ];
    let blurred: [Vec<f32>; 3] = [
        gaussian_blur_plane_sigma(&planes[0], w, h, sigma),
        gaussian_blur_plane_sigma(&planes[1], w, h, sigma),
        gaussian_blur_plane_sigma(&planes[2], w, h, sigma),
    ];

    // Per-channel unsharp: each channel's sharpened value is built from
    // its own delta. Apply the same shadow guard / clamp shape as the
    // real impl so the only structural difference is per-channel vs
    // luma-shared. (The shadow guard here uses each channel
    // individually, which is itself part of the failure mode.)
    let observed = img.pixels.clone();
    let mut sharpened: Vec<[f32; 3]> = vec![[0.0; 3]; img.pixels.len()];
    for i in 0..img.pixels.len() {
        for c in 0..3 {
            let oi = planes[c][i];
            let ob = blurred[c][i];
            let lo = oi + (oi - ob);
            let weight = smoothstep(SHADOW_EPSILON, SHADOW_BAND * SHADOW_EPSILON, oi);
            let safe = oi.max(SHADOW_EPSILON);
            let raw_scale = lo / safe;
            let bounded = raw_scale.clamp(MIN_SCALE, MAX_SCALE);
            let scale = 1.0 + weight * (bounded - 1.0);
            sharpened[i][c] = observed[i][c] * scale;
        }
    }

    // Edge-aware mix mirrors the real path. Build the gradient from
    // the per-channel-summed (proxy luma) so the mix factor isn't the
    // discriminator; the chroma-drift signal must come from the
    // per-channel scale itself.
    let proxy_luma: Vec<f32> = observed.iter().map(|p| p[0] + p[1] + p[2]).collect();
    let overall_mix = (amount / 100.0).clamp(0.0, 1.5);
    let detail_atten = (detail / 100.0).clamp(0.0, 1.0);
    let masking_threshold = (masking / 100.0).clamp(0.0, 1.0);
    let w_i = img.width as i32;
    let h_i = img.height as i32;
    let gradient = |x: i32, y: i32| -> f32 {
        let idx = |xi: i32, yi: i32| -> usize {
            let xc = xi.clamp(0, w_i - 1) as usize;
            let yc = yi.clamp(0, h_i - 1) as usize;
            yc * (w_i as usize) + xc
        };
        let gx = proxy_luma[idx(x + 1, y)] - proxy_luma[idx(x - 1, y)];
        let gy = proxy_luma[idx(x, y + 1)] - proxy_luma[idx(x, y - 1)];
        (gx * gx + gy * gy).sqrt()
    };
    for y in 0..h_i {
        for x in 0..w_i {
            let i = (y * w_i + x) as usize;
            let edge = if masking_threshold > 1e-3 {
                let g = gradient(x, y);
                let g_norm = (g / 0.2).clamp(0.0, 1.0);
                if g_norm >= masking_threshold {
                    1.0
                } else {
                    detail_atten
                }
            } else {
                1.0
            };
            let mix = overall_mix * edge;
            let o = observed[i];
            let s = sharpened[i];
            img.pixels[i] = [
                o[0] + (s[0] - o[0]) * mix,
                o[1] + (s[1] - o[1]) * mix,
                o[2] + (s[2] - o[2]) * mix,
            ];
        }
    }
}

/// Regression for ticket #439 (luminance-only to avoid color fringing on
/// high-contrast edges). A vertical step edge that ALSO carries chroma
/// — saturated red on one side, saturated cyan on the other — would
/// fringe under any per-channel sharpener: red and cyan have opposite
/// channel dominance (red is R-heavy, cyan is G+B-heavy), so an RGB
/// unsharp-mask boosts R on the red side and G+B on the cyan side,
/// pulling the edge pixels toward magenta / yellow casts they shouldn't
/// carry.
///
/// Under luma-only USM the scale is a single scalar per pixel applied
/// to all three channels, so R:G:B ratios are preserved on both sides
/// of the edge AND on the transition pixels themselves. We assert that
/// every pixel on the canvas — including the edge transition — keeps
/// the chroma ratio it started with (within a tight tolerance).
#[test]
fn saturated_edge_has_no_chroma_fringing() {
    let w = 32u32;
    let h = 8u32;
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    // Left half: saturated red. Right half: saturated cyan. Both
    // sides carry strong chroma with opposite channel dominance
    // (R-heavy vs G+B-heavy), so an RGB-per-channel sharpener
    // would boost R on the red side and G+B on the cyan side
    // independently — that's exactly the failure mode the ticket
    // calls out. Our assertions are on *ratio preservation*, which
    // the luma-only path enforces by construction regardless of
    // the luma magnitudes of the two sides.
    let left = [0.40_f32, 0.05, 0.05];
    let right = [0.05_f32, 0.40, 0.40];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let p = if x < (w / 2) as usize { left } else { right };
            img.pixels[y * w as usize + x] = p;
        }
    }
    let before = img.pixels.clone();
    apply(&mut img, 100.0, 1.0, 25.0, 0.0);

    // Every pixel: scaled by a single scalar k, so output/input
    // must be identical across the three channels.
    for i in 0..img.pixels.len() {
        let a = before[i];
        let b = img.pixels[i];
        // Reconstruct the per-channel scale.
        let kr = b[0] / a[0].max(1e-6);
        let kg = b[1] / a[1].max(1e-6);
        let kb = b[2] / a[2].max(1e-6);
        assert!(
            (kr - kg).abs() < 1e-4 && (kg - kb).abs() < 1e-4,
            "pixel {} drifted off luma-only scaling: in={:?} out={:?} kr/kg/kb = {} {} {}",
            i,
            a,
            b,
            kr,
            kg,
            kb,
        );
        // Chroma ratio (R:G:B) must be preserved bit-for-bit (within
        // float tolerance): if a[0]/a[1] == c, then b[0]/b[1] == c.
        let r_in = a[0] / a[1].max(1e-6);
        let r_out = b[0] / b[1].max(1e-6);
        let g_in = a[2] / a[1].max(1e-6);
        let g_out = b[2] / b[1].max(1e-6);
        assert!(
            (r_in - r_out).abs() < 1e-4,
            "pixel {} R/G chroma ratio drifted: in={} out={}",
            i,
            r_in,
            r_out,
        );
        assert!(
            (g_in - g_out).abs() < 1e-4,
            "pixel {} B/G chroma ratio drifted: in={} out={}",
            i,
            g_in,
            g_out,
        );
    }

    // And the edge should actually have moved — confirm the test
    // isn't trivially passing because sharpening did nothing.
    let cy = (h / 2) as usize;
    let left_edge = cy * (w as usize) + (w as usize / 2 - 1);
    let right_edge = cy * (w as usize) + (w as usize / 2);
    let left_delta = (img.pixels[left_edge][1] - before[left_edge][1]).abs()
        + (img.pixels[left_edge][2] - before[left_edge][2]).abs();
    let right_delta = (img.pixels[right_edge][1] - before[right_edge][1]).abs()
        + (img.pixels[right_edge][2] - before[right_edge][2]).abs();
    assert!(
        left_delta > 1e-4 || right_delta > 1e-4,
        "sharpen did nothing on the edge — chroma-ratio test is vacuous",
    );
}

/// Control test for `saturated_edge_has_no_chroma_fringing`: run the
/// broken per-channel reference on the same red/cyan edge fixture and
/// assert it DOES drift chroma. This proves the assertion mechanism
/// in the real test would catch a regression to per-channel unsharp —
/// the failure mode pre-#439 sharpen exhibited.
///
/// PR #450 did the same negative-case validation for clarity by hand
/// (inverting the implementation locally); this test pins it
/// permanently for sharpen. Closes part of #457.
#[test]
fn broken_per_channel_reference_does_drift_chroma() {
    let w = 32u32;
    let h = 8u32;
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    let left = [0.40_f32, 0.05, 0.05];
    let right = [0.05_f32, 0.40, 0.40];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let p = if x < (w / 2) as usize { left } else { right };
            img.pixels[y * w as usize + x] = p;
        }
    }
    let before = img.pixels.clone();
    apply_broken_per_channel(&mut img, 100.0, 1.0, 25.0, 0.0);

    // Inverted-impl expectation: somewhere on this fixture, the broken
    // per-channel scales must diverge (kr != kg or kg != kb beyond
    // f32 round-off). The same tolerance as the real test (1e-4) is
    // used as the failure threshold so this control proves the EXACT
    // assertion in `saturated_edge_has_no_chroma_fringing` would bite.
    let mut drifted = false;
    let mut worst_pixel = (0usize, [0f32; 3], [0f32; 3], 0f32, 0f32, 0f32);
    let mut worst_spread = 0.0f32;
    for i in 0..img.pixels.len() {
        let a = before[i];
        let b = img.pixels[i];
        let kr = b[0] / a[0].max(1e-6);
        let kg = b[1] / a[1].max(1e-6);
        let kb = b[2] / a[2].max(1e-6);
        let spread = (kr - kg).abs().max((kg - kb).abs());
        if spread > worst_spread {
            worst_spread = spread;
            worst_pixel = (i, a, b, kr, kg, kb);
        }
        if (kr - kg).abs() >= 1e-4 || (kg - kb).abs() >= 1e-4 {
            drifted = true;
        }
    }
    assert!(
        drifted,
        "control failed: broken per-channel reference did NOT drift \
         chroma above the real test's 1e-4 tolerance — \
         saturated_edge_has_no_chroma_fringing would not bite on a \
         regression. Worst pixel: idx={} in={:?} out={:?} \
         kr/kg/kb={}/{}/{} (max spread {:.2e})",
        worst_pixel.0,
        worst_pixel.1,
        worst_pixel.2,
        worst_pixel.3,
        worst_pixel.4,
        worst_pixel.5,
        worst_spread,
    );
}

#[test]
fn smoothstep_endpoints() {
    assert_eq!(smoothstep(0.0, 1.0, -0.5), 0.0);
    assert_eq!(smoothstep(0.0, 1.0, 0.0), 0.0);
    assert!((smoothstep(0.0, 1.0, 0.5) - 0.5).abs() < 1e-6);
    assert_eq!(smoothstep(0.0, 1.0, 1.0), 1.0);
    assert_eq!(smoothstep(0.0, 1.0, 1.5), 1.0);
}

/// A 32×32 mid-gray field with a single bright impulse at the centre —
/// luma everywhere is far above `SHADOW_EPSILON`, so the USM scale is
/// live at every pixel and the blur kernel's footprint shows up directly
/// in the sharpen response ring around the impulse.
fn impulse_image() -> Image {
    let mut img = Image::new(32, 32, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.18, 0.18, 0.18];
    }
    img.pixels[16 * 32 + 16] = [1.0, 1.0, 1.0];
    img
}

/// Sum of |out - in| over all pixels at Chebyshev distance >= `min_d`
/// from the impulse — the sharpening "halo energy" beyond a given ring.
/// The unsharp delta at a ring pixel is proportional to the blur
/// kernel's weight at that distance, so this grows with sigma.
fn halo_energy_beyond(before: &Image, after: &Image, min_d: i32) -> f32 {
    let w = 32i32;
    let (cx, cy) = (16i32, 16i32);
    let mut e = 0.0f32;
    for y in 0..32i32 {
        for x in 0..32i32 {
            let d = (x - cx).abs().max((y - cy).abs());
            if d < min_d {
                continue;
            }
            let i = (y * w + x) as usize;
            for c in 0..3 {
                e += (after.pixels[i][c] - before.pixels[i][c]).abs();
            }
        }
    }
    e
}

/// THE #1083 REGRESSION TEST: radius 0.5 and radius 3.0 must produce
/// materially different outputs with everything else fixed. Pre-fix,
/// `radius.round() as usize` → `(radius_px / 3).max(1)` collapsed every
/// legal radius to the SAME 1-px box cascade, so this assertion fails on
/// the old code (the two renders were bit-identical).
#[test]
fn radius_extremes_produce_different_outputs() {
    let base = impulse_image();

    let mut narrow = base.clone();
    apply(&mut narrow, 100.0, 0.5, 25.0, 0.0);
    let mut wide = base.clone();
    apply(&mut wide, 100.0, 3.0, 25.0, 0.0);

    // Both must actually sharpen (non-vacuous).
    let narrow_moved = halo_energy_beyond(&base, &narrow, 0);
    let wide_moved = halo_energy_beyond(&base, &wide, 0);
    assert!(
        narrow_moved > 1e-3,
        "radius=0.5 did nothing ({narrow_moved})"
    );
    assert!(wide_moved > 1e-3, "radius=3.0 did nothing ({wide_moved})");

    // And they must differ from EACH OTHER, materially.
    let mut diff = 0.0f32;
    let mut max_px_diff = 0.0f32;
    for (a, b) in narrow.pixels.iter().zip(wide.pixels.iter()) {
        for c in 0..3 {
            let d = (a[c] - b[c]).abs();
            diff += d;
            max_px_diff = max_px_diff.max(d);
        }
    }
    assert!(
        diff > 0.05 && max_px_diff > 1e-3,
        "radius 0.5 vs 3.0 outputs are (near-)identical: total |diff| = {diff:e}, \
         max per-pixel = {max_px_diff:e} — the Radius slider is a no-op again (#1083)"
    );

    // The wide radius must spread its halo further than the narrow one:
    // beyond 2 px from the impulse, σ=0.5's Gaussian weight is ~0 while
    // σ=3.0's is substantial.
    let narrow_far = halo_energy_beyond(&base, &narrow, 2);
    let wide_far = halo_energy_beyond(&base, &wide, 2);
    assert!(
        wide_far > narrow_far * 4.0,
        "radius=3.0 halo beyond 2 px ({wide_far:e}) is not materially wider than \
         radius=0.5's ({narrow_far:e})"
    );
}

/// Blur footprint grows MONOTONICALLY across the documented radius range
/// {0.5, 1, 2, 3}: the sharpen-response energy beyond 2 px from an
/// impulse strictly increases with sigma. Locks the radius → kernel
/// mapping as injective-and-ordered, not merely "extremes differ".
#[test]
fn radius_monotonically_widens_halo() {
    let base = impulse_image();
    let radii = [0.5f32, 1.0, 2.0, 3.0];
    let mut spreads = Vec::with_capacity(radii.len());
    for &r in &radii {
        let mut img = base.clone();
        apply(&mut img, 100.0, r, 25.0, 0.0);
        spreads.push(halo_energy_beyond(&base, &img, 2));
    }
    eprintln!("sharpen halo energy beyond 2 px over radii {radii:?}: {spreads:?}");
    for i in 1..spreads.len() {
        assert!(
            spreads[i] > spreads[i - 1],
            "halo energy not strictly increasing at radius {} -> {}: {:?}",
            radii[i - 1],
            radii[i],
            spreads
        );
    }
    // Non-vacuous: the full range must spread the halo by a wide margin.
    assert!(
        spreads[3] > spreads[0] * 4.0,
        "radius 3.0 halo ({:e}) not materially wider than radius 0.5's ({:e})",
        spreads[3],
        spreads[0]
    );
}
