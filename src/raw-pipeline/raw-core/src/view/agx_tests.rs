//! Unit tests for [`super`] (the AgX view transform) — split out of
//! `agx.rs` to keep that file under the 600-line hard budget.

use super::*;

#[test]
fn lut_size_matches_declared_constant() {
    assert_eq!(lut().len(), AGX_LUT_SIZE);
}

#[test]
fn lut_anchors_are_zero_and_near_one() {
    // Sobotka sigmoid evaluates to ~0 at x=0 and slightly below 1.0 at
    // x=1. The pipeline clamps post-outset; both endpoint anchors
    // should be in the expected range.
    let l = lut();
    assert!(l[0].abs() < 1e-3, "LUT[0] = {}", l[0]);
    assert!(
        l[AGX_LUT_SIZE - 1] >= 0.97 && l[AGX_LUT_SIZE - 1] <= 1.0,
        "LUT[last] = {}, expected in [0.97, 1.0]",
        l[AGX_LUT_SIZE - 1]
    );
}

#[test]
fn lut_is_monotone_nondecreasing() {
    let l = lut();
    for i in 1..AGX_LUT_SIZE {
        assert!(
            l[i] >= l[i - 1] - 1e-6,
            "non-monotone at {}: {} → {}",
            i,
            l[i - 1],
            l[i]
        );
    }
}

#[test]
fn lut_pivot_value_equals_y_pivot() {
    // Canonical Sobotka sigmoid: sigmoid(X_PIVOT) = Y_PIVOT = 0.18.
    // The LUT entry closest to AGX_X_PIVOT must land within
    // interpolation tolerance of AGX_Y_PIVOT.
    let l = lut();
    let pivot_norm = AGX_X_PIVOT;
    let idx = pivot_norm * ((AGX_LUT_SIZE - 1) as f32);
    let i0 = idx.floor() as usize;
    let i1 = (i0 + 1).min(AGX_LUT_SIZE - 1);
    let f = idx - (i0 as f32);
    let sampled = l[i0] * (1.0 - f) + l[i1] * f;
    assert!(
        (sampled - AGX_Y_PIVOT).abs() < 1e-4,
        "LUT @ X_PIVOT = {}, expected Y_PIVOT = {} (diff {})",
        sampled,
        AGX_Y_PIVOT,
        (sampled - AGX_Y_PIVOT).abs()
    );
}

#[test]
fn inset_outset_row_sums_are_one() {
    // The structural guarantee that makes neutral grey-axis preservation
    // work. If either matrix's row sums drift away from 1, neutral
    // mid-gray no longer maps to neutral mid-gray.
    for row in &AGX_INSET_MATRIX {
        let s: f32 = row.iter().sum();
        assert!((s - 1.0).abs() < 1e-6, "INSET row sum {} ≠ 1.0", s);
    }
    for row in &AGX_OUTSET_MATRIX {
        let s: f32 = row.iter().sum();
        assert!((s - 1.0).abs() < 1e-6, "OUTSET row sum {} ≠ 1.0", s);
    }
}

#[test]
fn inset_outset_are_numerical_inverses() {
    // Pure mathematical sanity: INSET @ OUTSET = I within fp tolerance.
    let mut product = [[0.0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let mut s = 0.0f32;
            for k in 0..3 {
                s += AGX_INSET_MATRIX[i][k] * AGX_OUTSET_MATRIX[k][j];
            }
            product[i][j] = s;
        }
    }
    for i in 0..3 {
        for j in 0..3 {
            let expected = if i == j { 1.0 } else { 0.0 };
            assert!(
                (product[i][j] - expected).abs() < 1e-5,
                "INSET @ OUTSET[{},{}] = {}, expected {}",
                i,
                j,
                product[i][j],
                expected
            );
        }
    }
}

#[test]
fn mid_gray_identity_preserved() {
    // The load-bearing #263 acceptance criterion: scene-linear neutral
    // 0.18 must land at display-linear 0.18 within 1e-3.
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [AGX_MID_GRAY, AGX_MID_GRAY, AGX_MID_GRAY];
    apply(&mut img, 0.0);
    let p = img.pixels[0];
    for &c in &p {
        assert!(
            (c - AGX_MID_GRAY).abs() < 1e-3,
            "mid-gray identity broken: {} ≠ 0.18 (|Δ|={:.2e})",
            c,
            (c - AGX_MID_GRAY).abs()
        );
    }
}

#[test]
fn mid_gray_anchor_preserved() {
    // Companion to `mid_gray_identity_preserved` — assert against the
    // declared anchor constant. With Y_PIVOT=0.18, AGX_MID_DISPLAY=0.18
    // by construction; both should agree under the full pipeline.
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [AGX_MID_GRAY, AGX_MID_GRAY, AGX_MID_GRAY];
    apply(&mut img, 0.0);
    let p = img.pixels[0];
    assert!(
        (p[0] - AGX_MID_DISPLAY).abs() < 1e-3,
        "R = {}, expected near {} (AGX_MID_DISPLAY)",
        p[0],
        AGX_MID_DISPLAY
    );
}

/// #1624: a bright saturated-primary ramp must lose chroma smoothly on
/// its way to white — no chroma cliff at the top — while the pixel's
/// max channel (brightness) tracks the ratio-sigmoid path unchanged.
/// Measured in AgX-Base space (post-sigmoid, pre-outset) via the
/// public stage: chroma = (max − min) / max of the display output,
/// which is monotone non-increasing across the ramp once the knee is
/// crossed and lands near zero at the top.
#[test]
fn saturated_ramp_sheds_chroma_smoothly_toward_white() {
    // Scene-linear red ramp, 0.5 → 200 (≈ +8.6 EV over mid-grey).
    let stops = 40;
    let mut prev_chroma = f32::INFINITY;
    let mut max_step = 0.0_f32;
    let mut top_chroma = 0.0_f32;
    for i in 0..=stops {
        let ev = -1.0 + 9.6 * (i as f32 / stops as f32);
        let r = AGX_MID_GRAY * ev.exp2();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [r, r * 0.05, r * 0.05];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        let mx = p[0].max(p[1]).max(p[2]);
        let mn = p[0].min(p[1]).min(p[2]);
        let chroma = if mx > 1e-6 { (mx - mn) / mx } else { 0.0 };
        // Above the knee the chroma may only fall, and never by a
        // cliff: cap the per-step drop at 15 % of the full range.
        if mx > AGX_P2W_KNEE {
            assert!(
                chroma <= prev_chroma + 1e-4,
                "chroma rose above the knee at step {i}: {prev_chroma} → {chroma}"
            );
            max_step = max_step.max(prev_chroma.min(1.0) - chroma);
        }
        prev_chroma = chroma;
        top_chroma = chroma;
    }
    assert!(
        max_step < 0.15,
        "chroma cliff: a single ramp step dropped chroma by {max_step}"
    );
    assert!(
        top_chroma < 0.05,
        "ramp must land near white at the top: residual chroma {top_chroma}"
    );
}

/// #1624: the weight is identity at and below the knee (mid-grey and the
/// whole shadow/midtone range), full `AGX_P2W_AMOUNT` at display white.
#[test]
fn path_to_white_weight_is_zero_below_knee_and_full_at_white() {
    for sn in [0.0_f32, AGX_MID_DISPLAY, 0.5, AGX_P2W_KNEE] {
        assert_eq!(path_to_white_weight(sn), 0.0, "sn={sn}");
    }
    assert!((path_to_white_weight(1.0) - AGX_P2W_AMOUNT).abs() < 1e-6);
    let mid = path_to_white_weight((AGX_P2W_KNEE + 1.0) * 0.5);
    assert!(mid > 0.0 && mid < AGX_P2W_AMOUNT);
}

/// #1624: a saturated colour BELOW the knee renders bit-identically to
/// the pre-#1624 chain (the step is a no-op there), so midtone chroma
/// is untouched.
#[test]
fn path_to_white_leaves_midtone_chroma_untouched() {
    let scene = [0.30_f32, 0.06, 0.04];
    let inset = matrix_mul(&AGX_INSET_MATRIX, scene);
    let sig = norm_sigmoid_ratio(inset, |x| {
        let norm = log_encode(x);
        sample_lut(norm)
    });
    assert!(
        sig.iter().all(|c| *c < AGX_P2W_KNEE),
        "fixture must sit below the knee: {sig:?}"
    );
    assert_eq!(path_to_white(sig), sig);
}

#[test]
fn huge_scene_values_map_below_or_equal_one() {
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [100.0, 50.0, 20.0];
    apply(&mut img, 0.0);
    for &c in &img.pixels[0] {
        assert!(c <= 1.0 + 1e-5 && c >= 0.0, "{} should be in [0, 1]", c);
    }
}

#[test]
fn negative_inputs_clamp_to_toe() {
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [-0.3, 0.0, 0.1];
    apply(&mut img, 0.0);
    for &c in &img.pixels[0] {
        assert!(c.is_finite() && c >= 0.0 && c <= 1.0, "{} out of bounds", c);
    }
}

#[test]
fn output_space_becomes_display_linear() {
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.18, 0.18, 0.18];
    apply(&mut img, 0.0);
    assert_eq!(img.space, ColorSpace::DisplayLinearRec2020);
}

#[test]
fn positive_contrast_steepens_around_mid_gray() {
    let scene_bright = 0.5;
    let scene_dark = 0.05;

    let mut img = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [scene_bright; 3];
    img.pixels[1] = [scene_dark; 3];
    apply(&mut img, 0.0);
    let (base_bright, base_dark) = (img.pixels[0][0], img.pixels[1][0]);

    let mut img2 = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
    img2.pixels[0] = [scene_bright; 3];
    img2.pixels[1] = [scene_dark; 3];
    apply(&mut img2, 100.0);
    assert!(
        img2.pixels[0][0] > base_bright,
        "bright should go higher at +100: {} vs {}",
        img2.pixels[0][0],
        base_bright
    );
    assert!(
        img2.pixels[1][0] < base_dark,
        "dark should go lower at +100: {} vs {}",
        img2.pixels[1][0],
        base_dark
    );
}

#[test]
fn saturated_highlight_reduces_in_spread() {
    // A scene with one channel way out of gamut (e.g., saturated red
    // specular at 20× mid-gray, green/blue at mid-gray). The inset
    // matrix bakes per-channel desat into the sigmoid input, so R rolls
    // off toward 1 while G/B sit below; the ratio-preserving sigmoid
    // (#435) and Oklab gamut compression keep the result hue-correct
    // and inside [0, 1]^3.
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [20.0 * AGX_MID_GRAY, AGX_MID_GRAY, AGX_MID_GRAY];
    apply(&mut img, 0.0);
    let p = img.pixels[0];
    assert!(p[0] > p[1], "R < G: {} vs {}", p[0], p[1]);
    // After ratio-preserving sigmoid the spread can approach but cannot
    // exceed 1.0 (output is bounded in `[0, 1]`). The earlier 1−mid_gray
    // bound was a per-channel-sigmoid artefact and doesn't hold under
    // ratio-preservation; the load-bearing invariant is "stays in gamut",
    // which `lands_in_unit_box` and `gamut_compress_lands_in_unit_box`
    // already cover. Here we just confirm a real spread exists (the
    // pixel isn't flattened to neutral) and the output channels are
    // legal.
    for &c in &p {
        assert!(c >= 0.0 && c <= 1.0, "out of [0,1]: {}", c);
    }
    assert!(
        p[0] - p[1] > 0.05,
        "R-G spread collapsed: {} vs {}",
        p[0],
        p[1]
    );
}

#[test]
fn neutral_axis_preserved_across_log_domain() {
    // The matrices have row-sums-of-1, so every neutral RGB input
    // (R=G=B) must produce a neutral RGB output. This is the load-
    // bearing structural property that makes mid-gray preserve.
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    for scene in &[0.001f32, 0.01, 0.05, 0.18, 0.5, 1.0, 5.0] {
        img.pixels[0] = [*scene, *scene, *scene];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        // R, G, B should all match within fp tolerance.
        assert!(
            (p[0] - p[1]).abs() < 1e-4 && (p[1] - p[2]).abs() < 1e-4,
            "neutral input {} → non-neutral output {:?}",
            scene,
            p
        );
        // And output should stay in [0, 1].
        for &c in &p {
            assert!(c >= 0.0 && c <= 1.0, "out of [0,1]: {}", c);
        }
        // Reset color-space marker for the next iteration.
        img.space = ColorSpace::SceneLinearRec2020;
    }
}

#[test]
fn deep_shadow_chroma_preserved_via_ratio_sigmoid() {
    // A pixel in deep shadow with a non-trivial R:G:B ratio. Pre-#435
    // the per-channel sigmoid + per-channel toe clamp could clip one
    // channel asymmetrically and produce magenta. The ratio-preserving
    // sigmoid scales R, G, B by the same factor (sigmoid(max)/max),
    // so the input chroma direction is preserved exactly.
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    let floor = AGX_MID_GRAY * AGX_MIN_EV.exp2();
    let r = 0.005f32;
    let g = 0.001f32;
    let b = floor * 0.5; // intentionally below the per-channel toe floor
    img.pixels[0] = [r, g, b];
    apply(&mut img, 0.0);
    let p = img.pixels[0];
    // R should remain larger than G in display space — chroma preserved
    // through the INSET → ratio sigmoid → OUTSET round-trip.
    assert!(
        p[0] > p[1],
        "deep shadow chroma collapsed: R={} not > G={}",
        p[0],
        p[1]
    );
}

#[test]
fn below_toe_luminance_collapses_to_neutral() {
    // Companion to `deep_shadow_chroma_preserved_*`: when luma itself
    // is below the toe (truly black pixel), all channels collapse to
    // the floor uniformly. No magenta in deep-deep shadow.
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.0, 0.0, 0.0];
    apply(&mut img, 0.0);
    let p = img.pixels[0];
    // Pure black input must produce a neutral output (all three
    // channels equal). Mid-gray of zero through the pipeline can be
    // very slightly above zero from inset/outset rounding, but R, G,
    // and B must agree.
    assert!(
        (p[0] - p[1]).abs() < 1e-4 && (p[1] - p[2]).abs() < 1e-4,
        "zero input → non-neutral output {:?}",
        p
    );
}

/// LUT byte-equality between raw-core's embedded copy and the
/// Apple SwiftPM-bundled mirror. Both are written by the same
/// `derive_agx_lut.py --bin … --apple-bin …` invocation, so any
/// divergence means the script wasn't re-run after a coefficient
/// edit.
#[test]
fn lut_hash_matches_apple_bundle() {
    // Resolve the Apple-bundled LUT relative to CARGO_MANIFEST_DIR.
    // The file is COMMITTED (not a gitignored fixture), so absence is a
    // broken checkout — fail loudly rather than skip-pass (#1082).
    let apple_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apple/Packages/MapleCore/Sources/MapleCore/Metal/agx_lut.bin");
    assert!(
        apple_path.exists(),
        "Apple-bundled agx_lut.bin not found at {} — it is committed to the \
         repo, so this is a broken/partial checkout, not a missing fixture",
        apple_path.display()
    );
    let apple_bytes = std::fs::read(&apple_path)
        .unwrap_or_else(|e| panic!("read {} failed: {}", apple_path.display(), e));
    assert_eq!(
        apple_bytes.len(),
        AGX_LUT_BYTES.len(),
        "Apple-bundled LUT size {} differs from Rust LUT size {}",
        apple_bytes.len(),
        AGX_LUT_BYTES.len()
    );
    // Byte-equality is the parity gate; the LUT is a single source of
    // truth (derive_agx_lut.py emits both with --apple-bin).
    assert_eq!(
        apple_bytes.as_slice(),
        AGX_LUT_BYTES,
        "Apple-bundled agx_lut.bin diverges from Rust LUT. Re-run \
         `python3 src/scripts/derive_agx_lut.py --bin … --rs … --apple-bin …`."
    );
}
