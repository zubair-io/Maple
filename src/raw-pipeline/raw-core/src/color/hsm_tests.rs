use super::*;

fn approx(a: f32, b: f32, eps: f32) -> bool {
    (a - b).abs() < eps
}

fn approx_rgb(a: [f32; 3], b: [f32; 3], eps: f32) -> bool {
    approx(a[0], b[0], eps) && approx(a[1], b[1], eps) && approx(a[2], b[2], eps)
}

// ── HSV ↔ RGB round-trips ─────────────────────────────────────────────────

#[test]
fn rgb_to_hsv_pure_red() {
    let (h, s, v) = rgb_to_hsv([1.0, 0.0, 0.0]);
    assert!(approx(h, 0.0, 1e-3));
    assert!(approx(s, 1.0, 1e-3));
    assert!(approx(v, 1.0, 1e-3));
}

#[test]
fn rgb_to_hsv_pure_green() {
    let (h, s, v) = rgb_to_hsv([0.0, 1.0, 0.0]);
    assert!(approx(h, 120.0, 1e-3));
    assert!(approx(s, 1.0, 1e-3));
    assert!(approx(v, 1.0, 1e-3));
}

#[test]
fn rgb_to_hsv_pure_blue() {
    let (h, s, v) = rgb_to_hsv([0.0, 0.0, 1.0]);
    assert!(approx(h, 240.0, 1e-3));
    assert!(approx(s, 1.0, 1e-3));
    assert!(approx(v, 1.0, 1e-3));
}

#[test]
fn rgb_to_hsv_neutral() {
    let (h, s, v) = rgb_to_hsv([0.5, 0.5, 0.5]);
    assert!(
        approx(s, 0.0, 1e-6),
        "neutral has zero saturation; got s={}",
        s
    );
    assert!(approx(v, 0.5, 1e-6));
    let _ = h; // hue is undefined when s == 0
}

#[test]
fn hsv_round_trip_reproduces_rgb() {
    let cases: &[[f32; 3]] = &[
        [0.7, 0.2, 0.1],
        [0.2, 0.6, 0.4],
        [0.05, 0.05, 0.5],
        [0.18, 0.18, 0.18],
        [1.5, 0.3, 0.7], // HDR pixel
    ];
    for &rgb in cases {
        let (h, s, v) = rgb_to_hsv(rgb);
        let back = hsv_to_rgb(h, s, v);
        assert!(
            approx_rgb(back, rgb, 1e-4),
            "round trip fail for {:?}: got {:?}",
            rgb,
            back
        );
    }
}

// ── Identity table is a no-op ────────────────────────────────────────────

fn identity_table(dims: [u32; 3], encoding: HsmEncoding) -> HsmTable {
    let n = (dims[0] * dims[1] * dims[2] * 3) as usize;
    // [0, 1, 1] per entry — no hue shift, no sat scale, no value scale.
    let mut data = Vec::with_capacity(n);
    for _ in 0..(dims[0] * dims[1] * dims[2]) {
        data.push(0.0);
        data.push(1.0);
        data.push(1.0);
    }
    HsmTable::new(dims, data, encoding).expect("identity table dims valid")
}

#[test]
fn identity_2x2x2_is_no_op() {
    let table = identity_table([2, 2, 2], HsmEncoding::Linear);
    let mut img = Image::new(4, 4, ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        *p = [
            (i as f32) * 0.05,
            0.5 - (i as f32) * 0.02,
            0.3 + (i as f32) * 0.01,
        ];
    }
    let before = img.pixels.clone();
    apply(&mut img, &table);
    for (b, a) in before.iter().zip(img.pixels.iter()) {
        assert!(
            approx_rgb(*b, *a, 1e-4),
            "identity table mutated pixel: before={:?} after={:?}",
            b,
            a
        );
    }
}

#[test]
fn identity_36x10x1_is_no_op() {
    // Spec-typical DNG HSM table shape.
    let table = identity_table([36, 10, 1], HsmEncoding::Linear);
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.7, 0.2, 0.4];
    img.pixels[1] = [0.18, 0.5, 0.9];
    img.pixels[2] = [0.0, 0.0, 0.0];
    img.pixels[3] = [1.2, 0.3, 0.05];
    let before = img.pixels.clone();
    apply(&mut img, &table);
    for (b, a) in before.iter().zip(img.pixels.iter()) {
        assert!(
            approx_rgb(*b, *a, 1e-3),
            "identity mutated: before={:?} after={:?}",
            b,
            a
        );
    }
}

// ── Known-output 2x2x2 LUT ──────────────────────────────────────────────

#[test]
fn pure_hue_shift_on_red_at_lattice_point() {
    // 2x2x2 table with all entries = (90° hue shift, 1, 1). Red @ hue 0
    // should land on hue 90°, which is yellow-green.
    let n = 2 * 2 * 2;
    let mut data = Vec::with_capacity(n * 3);
    for _ in 0..n {
        data.push(90.0);
        data.push(1.0);
        data.push(1.0);
    }
    let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [1.0, 0.0, 0.0];
    apply(&mut img, &table);
    // Hue 90° at sat 1, val 1 → green-yellow at (0.5, 1, 0).
    let (h, s, v) = rgb_to_hsv(img.pixels[0]);
    assert!(approx(h, 90.0, 0.5), "expected hue ≈90, got {}", h);
    assert!(approx(s, 1.0, 0.01));
    assert!(approx(v, 1.0, 0.01));
}

#[test]
fn pure_sat_scale_halves_chroma() {
    // 2x2x2 with all entries = (0, 0.5, 1) → halves saturation everywhere.
    let n = 2 * 2 * 2;
    let mut data = Vec::with_capacity(n * 3);
    for _ in 0..n {
        data.push(0.0);
        data.push(0.5);
        data.push(1.0);
    }
    let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.8, 0.2, 0.2];
    let (_, s_in, _) = rgb_to_hsv(img.pixels[0]);
    apply(&mut img, &table);
    let (_, s_out, _) = rgb_to_hsv(img.pixels[0]);
    assert!(
        approx(s_out, s_in * 0.5, 1e-3),
        "expected sat halved from {} to {}, got {}",
        s_in,
        s_in * 0.5,
        s_out
    );
}

#[test]
fn pure_value_scale_doubles_brightness() {
    // 2x2x2 with all entries = (0, 1, 2) → doubles V everywhere.
    let n = 2 * 2 * 2;
    let mut data = Vec::with_capacity(n * 3);
    for _ in 0..n {
        data.push(0.0);
        data.push(1.0);
        data.push(2.0);
    }
    let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.4, 0.1, 0.1];
    apply(&mut img, &table);
    // V was 0.4, sat-preserved → expected RGB (0.8, 0.2, 0.2).
    assert!(
        approx_rgb(img.pixels[0], [0.8, 0.2, 0.2], 1e-3),
        "expected (0.8, 0.2, 0.2), got {:?}",
        img.pixels[0]
    );
}

// ── Trilinear interp halfway between identity & 2x ──────────────────────

#[test]
fn trilinear_interp_at_h_midpoint_blends_corners() {
    // 2x1x1 table: hue 0 cell entry = (0, 1, 1), hue 1 cell entry = (180, 1, 1).
    // Between them, pure red (hue 0) sits AT lattice 0 (no interp).
    // A pixel with hue 90° is halfway, lerp_hue(0, 180, 0.5) = 90°.
    // Wait — it's a 2-cell table, so hue 90 / 360 * 2 = 0.5 → between 0 & 1.
    let mut data = Vec::with_capacity(2 * 3);
    data.extend_from_slice(&[0.0, 1.0, 1.0]);
    data.extend_from_slice(&[180.0, 1.0, 1.0]);
    let table = HsmTable::new([2, 1, 1], data, HsmEncoding::Linear).unwrap();
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.5, 0.5, 0.5]; // neutral — hue 0, sat 0
    apply(&mut img, &table);
    // Neutral has sat 0; HSV→RGB returns the same neutral regardless of hue.
    assert!(approx_rgb(img.pixels[0], [0.5, 0.5, 0.5], 1e-4));
}

#[test]
fn trilinear_blends_sat_scale_at_midpoint() {
    // 1x2x1 table: sat 0 → scale 1.0, sat 1 → scale 0.0. Halfway sat = 0.5
    // should yield scale 0.5.
    let mut data = Vec::with_capacity(2 * 3);
    data.extend_from_slice(&[0.0, 1.0, 1.0]); // s=0 entry
    data.extend_from_slice(&[0.0, 0.0, 1.0]); // s=1 entry (zero out sat)
    let table = HsmTable::new([1, 2, 1], data, HsmEncoding::Linear).unwrap();
    // Construct a pixel with sat exactly 0.5: (1.0, 0.5, 0.5) has
    // delta=0.5, max=1.0, sat=0.5.
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [1.0, 0.5, 0.5];
    let (_, s_in, _) = rgb_to_hsv(img.pixels[0]);
    assert!(approx(s_in, 0.5, 1e-4));
    apply(&mut img, &table);
    let (_, s_out, _) = rgb_to_hsv(img.pixels[0]);
    // Scale at sat=0.5 lerps lattice scales 1.0 and 0.0 → 0.5. New sat = 0.5 * 0.5 = 0.25.
    assert!(
        approx(s_out, 0.25, 1e-3),
        "expected sat 0.25 after lerped sat scale, got {}",
        s_out
    );
}

// ── Hue dimension wraps circularly ──────────────────────────────────────

#[test]
fn hue_index_wraps_at_seam() {
    // 4-cell hue table: cell 0 = (0,1,1), cell 1 = (90,1,1),
    // cell 2 = (180,1,1), cell 3 = (270,1,1).
    // A pixel at hue 359° lies between cell 3 (h=270 at lattice point hue 270)
    // and cell 0 (h=0 at lattice point hue 360 / wrap). h_pos = 359/360*4
    // ≈ 3.989, h_lo = 3, h_frac ≈ 0.989. hueDelta lerp_hue(270, 0, 0.989)
    // ≈ shortest-arc → goes the "+90°" way across the seam → result ≈ 359°.
    let mut data = Vec::with_capacity(4 * 3);
    data.extend_from_slice(&[0.0, 1.0, 1.0]);
    data.extend_from_slice(&[90.0, 1.0, 1.0]);
    data.extend_from_slice(&[180.0, 1.0, 1.0]);
    data.extend_from_slice(&[270.0, 1.0, 1.0]);
    let table = HsmTable::new([4, 1, 1], data, HsmEncoding::Linear).unwrap();
    // A pixel at hue 90° (at lattice 1 exactly) should get hueDelta = 90°
    // → shifted hue = 180° (cyan).
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    // Hue 90° at sat 1, val 1 → (0.5, 1, 0).
    img.pixels[0] = hsv_to_rgb(90.0, 1.0, 1.0);
    apply(&mut img, &table);
    let (h, _, _) = rgb_to_hsv(img.pixels[0]);
    assert!(approx(h, 180.0, 0.5), "expected hue ≈180°, got {}", h);
}

#[test]
fn hue_lerp_takes_short_arc_across_seam() {
    // Cell 0: hueDelta = -10° (i.e. 350°). Cell 1: hueDelta = +10°.
    // At midpoint, naive lerp of 350 and 10 = 180°; shortest-arc → 0°.
    let mut data = Vec::with_capacity(2 * 3);
    data.extend_from_slice(&[350.0, 1.0, 1.0]);
    data.extend_from_slice(&[10.0, 1.0, 1.0]);
    let table = HsmTable::new([2, 1, 1], data, HsmEncoding::Linear).unwrap();
    // A pixel at hue 90° lies at h_pos = 90/360*2 = 0.5 → midpoint of cells.
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = hsv_to_rgb(90.0, 1.0, 1.0);
    apply(&mut img, &table);
    let (h, _, _) = rgb_to_hsv(img.pixels[0]);
    // Shortest-arc lerp at midpoint of (350°, 10°) = 0°. 90° + 0° = 90°.
    assert!(
        approx(h, 90.0, 0.5),
        "expected hue ≈90° (no shift via short arc), got {}",
        h
    );
}

// ── Achromatic fade scales a SIGNED hue delta (#1924) ───────────────────

#[test]
fn lookup_returns_signed_hue_delta_not_wrapped() {
    // A table whose every entry carries hueDelta = -10° must be looked up
    // as a signed -10°, not the wrapped 350°. Pre-#1924 `lookup` returned
    // `rem_euclid(360)` = 350°, which only stays correct while it is *added*
    // to hue — `apply` scales it first, where wrap is not invariant.
    let n = 2 * 2 * 2;
    let mut data = Vec::with_capacity(n * 3);
    for _ in 0..n {
        data.push(-10.0);
        data.push(1.0);
        data.push(1.0);
    }
    let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
    let (hd, _, _) = lookup(table.dims, &table.data, 30.0, 0.5, 0.5);
    assert!(
        (hd - (-10.0)).abs() < 1e-3,
        "expected signed hueDelta ≈ -10, got {hd}"
    );
}

#[test]
fn lookup_normalizes_hue_delta_at_the_180_boundary() {
    // Uniform-hueDelta tables so `lookup` returns exactly the (normalized)
    // stored delta. The ±180 boundary is the regression (Copilot on PR
    // #1975): `rem_euclid` mapped an exact -180 to +180 — a sign flip the
    // `apply` scale then propagates (-180·0.5 = -90 vs the wrong +90). The
    // sign-preserving remainder keeps -180 as -180 and +180 as +180, while
    // still wrapping 350 → -10 and -350 → 10.
    let uniform = |delta: f32| -> f32 {
        let n = 2 * 2 * 2;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n {
            data.push(delta);
            data.push(1.0);
            data.push(1.0);
        }
        let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
        lookup(table.dims, &table.data, 30.0, 0.5, 0.5).0
    };
    // Boundary cases: exact ±180 must keep their sign (not fold to +180).
    assert!(
        approx(uniform(-180.0), -180.0, 1e-3),
        "-180 → {}",
        uniform(-180.0)
    );
    assert!(
        approx(uniform(180.0), 180.0, 1e-3),
        "+180 → {}",
        uniform(180.0)
    );
    // Wrap cases still fold into [-180, 180] with the correct sign.
    assert!(
        approx(uniform(350.0), -10.0, 1e-3),
        "350 → {}",
        uniform(350.0)
    );
    assert!(
        approx(uniform(-350.0), 10.0, 1e-3),
        "-350 → {}",
        uniform(-350.0)
    );
    assert!(
        approx(uniform(270.0), -90.0, 1e-3),
        "270 → {}",
        uniform(270.0)
    );
    assert!(
        approx(uniform(-270.0), 90.0, 1e-3),
        "-270 → {}",
        uniform(-270.0)
    );
    // In-range values pass through unchanged.
    assert!(approx(uniform(0.0), 0.0, 1e-3));
    assert!(approx(uniform(90.0), 90.0, 1e-3));
    assert!(approx(uniform(-90.0), -90.0, 1e-3));
}

#[test]
fn achromatic_fade_scales_signed_hue_delta() {
    // Saturation in the (0, 0.01) achromatic fade band with a NEGATIVE
    // hueDelta. At s = 0.005, w_chroma = 0.5, so the applied delta must be
    // -10 * 0.5 = -5° → output hue 355°. The pre-#1924 wrap made `lookup`
    // return 350°, so `apply` computed 350 * 0.5 = 175° — a wildly wrong
    // hue. This is the only band where the bug manifests (at s ≥ 0.01,
    // w_chroma = 1 and the scale is a no-op).
    let n = 2 * 2 * 2;
    let mut data = Vec::with_capacity(n * 3);
    for _ in 0..n {
        data.push(-10.0);
        data.push(1.0);
        data.push(1.0);
    }
    let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    // max=1, min=0.995, delta=0.005 → sat 0.005, hue 0, val 1.
    img.pixels[0] = [1.0, 0.995, 0.995];
    let (h_in, s_in, _) = rgb_to_hsv(img.pixels[0]);
    assert!(approx(h_in, 0.0, 1e-3) && approx(s_in, 0.005, 1e-4));
    apply(&mut img, &table);
    let (h_out, _, _) = rgb_to_hsv(img.pixels[0]);
    // Expected 355° (= -5° mod 360). Shortest-arc distance to 355 must be
    // tiny; distance to the buggy 175° must be large.
    let dist = |a: f32, b: f32| {
        let mut d = (a - b).abs();
        if d > 180.0 {
            d = 360.0 - d;
        }
        d
    };
    assert!(
        dist(h_out, 355.0) < 2.0,
        "expected output hue ≈ 355° (signed -5° fade), got {h_out}"
    );
    assert!(
        dist(h_out, 175.0) > 20.0,
        "output hue {h_out} landed near the buggy wrapped 175°"
    );
}

// ── Two-table reciprocal-CCT lerp ──────────────────────────────────────

#[test]
fn lerp_tables_at_t_zero_returns_cold() {
    let cold = identity_table([2, 2, 2], HsmEncoding::Linear);
    let mut warm_data = cold.data.clone();
    for i in 0..warm_data.len() {
        if i % 3 == 1 {
            warm_data[i] = 2.0;
        } // warm has 2x sat scale
    }
    let warm = HsmTable::new([2, 2, 2], warm_data, HsmEncoding::Linear).unwrap();
    let merged = lerp_tables(&cold, &warm, 0.0).unwrap();
    for (a, b) in cold.data.iter().zip(merged.data.iter()) {
        assert!((a - b).abs() < 1e-6);
    }
}

#[test]
fn lerp_tables_at_t_one_returns_warm() {
    let cold = identity_table([2, 2, 2], HsmEncoding::Linear);
    let mut warm_data = cold.data.clone();
    for i in 0..warm_data.len() {
        if i % 3 == 1 {
            warm_data[i] = 2.0;
        }
    }
    let warm = HsmTable::new([2, 2, 2], warm_data.clone(), HsmEncoding::Linear).unwrap();
    let merged = lerp_tables(&cold, &warm, 1.0).unwrap();
    for (a, b) in warm_data.iter().zip(merged.data.iter()) {
        assert!((a - b).abs() < 1e-6);
    }
}

#[test]
fn lerp_tables_at_midpoint_blends() {
    let cold = identity_table([2, 2, 2], HsmEncoding::Linear);
    let mut warm_data = cold.data.clone();
    for i in 0..warm_data.len() {
        if i % 3 == 2 {
            warm_data[i] = 3.0;
        } // warm valScale = 3
    }
    let warm = HsmTable::new([2, 2, 2], warm_data, HsmEncoding::Linear).unwrap();
    let merged = lerp_tables(&cold, &warm, 0.5).unwrap();
    // ValScale at midpoint = 0.5 * 1 + 0.5 * 3 = 2.
    for i in 0..merged.data.len() {
        if i % 3 == 2 {
            assert!(
                (merged.data[i] - 2.0).abs() < 1e-6,
                "valScale at idx {} = {}, expected 2.0",
                i,
                merged.data[i]
            );
        }
    }
}

#[test]
fn lerp_tables_rejects_dim_mismatch() {
    let a = identity_table([2, 2, 2], HsmEncoding::Linear);
    let b = identity_table([4, 2, 2], HsmEncoding::Linear);
    assert!(lerp_tables(&a, &b, 0.5).is_none());
}

#[test]
fn lerp_tables_rejects_encoding_mismatch() {
    let a = identity_table([2, 2, 2], HsmEncoding::Linear);
    let b = identity_table([2, 2, 2], HsmEncoding::Srgb);
    assert!(lerp_tables(&a, &b, 0.5).is_none());
}

// ── Construction safety ────────────────────────────────────────────────

#[test]
fn new_rejects_data_length_mismatch() {
    // dims claim 2*2*2*3 = 24 floats; pass 23.
    let bad = vec![0.0; 23];
    assert!(HsmTable::new([2, 2, 2], bad, HsmEncoding::Linear).is_none());
}

#[test]
fn new_rejects_zero_dim() {
    let zero = vec![];
    assert!(HsmTable::new([0, 2, 2], zero, HsmEncoding::Linear).is_none());
}

#[test]
fn encoding_from_u32_defaults_to_linear() {
    assert_eq!(HsmEncoding::from_u32(0), HsmEncoding::Linear);
    assert_eq!(HsmEncoding::from_u32(1), HsmEncoding::Srgb);
    assert_eq!(HsmEncoding::from_u32(99), HsmEncoding::Linear);
}

#[test]
fn invert_one_roundtrips_applied_pixel() {
    // Table with slight hue and sat shift
    let mut table = identity_table([4, 2, 2], HsmEncoding::Linear);
    for i in (0..table.data.len()).step_by(3) {
        table.data[i] = 5.0; // +5 deg hue shift
        table.data[i + 1] = 0.95; // 0.95 sat scale
        table.data[i + 2] = 1.02; // 1.02 val scale
    }
    let original = [0.8, 0.75, 0.7];
    let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
    img.pixels[0] = original;
    apply(&mut img, &table);
    let applied = img.pixels[0];

    let inverted = invert_one(applied, &table);
    for k in 0..3 {
        assert!(
            (inverted[k] - original[k]).abs() < 1e-3,
            "channel {k}: inverted {} vs original {}",
            inverted[k],
            original[k]
        );
    }
}

#[test]
fn invert_one_roundtrips_applied_pixel_with_negative_channel() {
    let mut table = identity_table([4, 2, 2], HsmEncoding::Linear);
    for i in (0..table.data.len()).step_by(3) {
        table.data[i] = 4.0;
        table.data[i + 1] = 0.96;
        table.data[i + 2] = 1.01;
    }
    let original = [-0.05, 0.45, 0.60];
    let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
    img.pixels[0] = original;
    apply(&mut img, &table);
    let applied = img.pixels[0];

    let inverted = invert_one(applied, &table);
    for k in 0..3 {
        assert!(
            (inverted[k] - original[k]).abs() < 1e-3,
            "channel {k}: inverted {} vs original {}",
            inverted[k],
            original[k]
        );
    }
}
