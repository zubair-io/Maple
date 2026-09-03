use super::*;
use crate::types::{Mask, Point2};

fn flat_image(w: u32, h: u32, v: f32) -> Image {
    Image {
        width: w,
        height: h,
        pixels: vec![[v, v, v]; (w * h) as usize],
        space: ColorSpace::SceneLinearRec2020,
    }
}

#[test]
fn empty_layers_is_noop() {
    let mut img = flat_image(4, 4, 0.18);
    let snapshot = img.pixels.clone();
    apply(&mut img, &[]);
    assert_eq!(
        img.pixels, snapshot,
        "empty Vec must leave pixels untouched"
    );
}

#[test]
fn empty_partial_adjustments_is_noop() {
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments::default(), // every field None
    )];
    let mut img = flat_image(4, 4, 0.18);
    let snapshot = img.pixels.clone();
    apply(&mut img, &layers);
    assert_eq!(img.pixels, snapshot);
}

#[test]
fn linear_exposure_doubles_at_full_weight_side() {
    // Linear gradient from x=0 (w=0) to x=1 (w=1) with feather=0 (hard
    // step at the midpoint). Apply +1 EV: pixels in the w=1 half are
    // doubled, pixels in the w=0 half are unchanged.
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 0.0,
        },
        adjustments: PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    }];
    let mut img = flat_image(5, 1, 0.5);
    apply(&mut img, &layers);
    // x=0 (w=0) — unchanged.
    assert!(
        (img.pixels[0][0] - 0.5).abs() < 1e-5,
        "left edge: {}",
        img.pixels[0][0]
    );
    // x=4 (w=1) — doubled.
    assert!(
        (img.pixels[4][0] - 1.0).abs() < 1e-5,
        "right edge: {}",
        img.pixels[4][0]
    );
}

#[test]
fn radial_exposure_doubles_at_center() {
    // Radial mask centered at (0.5, 0.5) with radii (0.5, 0.5), feather
    // 0 — pixels exactly at the centre are w=1, edges are w=0.
    let layers = vec![LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(0.5, 0.5),
            angle: 0.0,
            feather: 0.0,
            invert: false,
        },
        adjustments: PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    }];
    // 3x3 image so the centre pixel (1, 1) maps exactly to (0.5, 0.5).
    let mut img = flat_image(3, 3, 0.25);
    apply(&mut img, &layers);
    // Centre pixel: w=1 → doubled.
    assert!(
        (img.pixels[4][0] - 0.5).abs() < 1e-5,
        "centre: {}",
        img.pixels[4][0]
    );
    // Corner pixel (0,0) — outside the radius, w=0 → unchanged.
    assert!(
        (img.pixels[0][0] - 0.25).abs() < 1e-5,
        "corner: {}",
        img.pixels[0][0]
    );
}

#[test]
fn local_temperature_shifts_blue() {
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.0),
            end: Point2::new(1.0, 0.0),
            feather: 0.0,
        },
        adjustments: PartialAdjustments {
            temperature: Some(-1000.0), // -1000K delta from 6500K
            ..Default::default()
        },
    }];
    let mut img = flat_image(2, 1, 0.5);
    apply(&mut img, &layers);
    // x=1 (w=1) — cooled (blue up, red down).
    assert!(img.pixels[1][2] > 0.5, "B: {}", img.pixels[1][2]);
    assert!(img.pixels[1][0] < 0.5, "R: {}", img.pixels[1][0]);
}

#[test]
fn local_contrast_increases_spread() {
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.0),
            end: Point2::new(1.0, 0.0),
            feather: 0.0,
        },
        adjustments: PartialAdjustments {
            contrast: Some(50.0),
            ..Default::default()
        },
    }];
    let mut img = flat_image(3, 1, 0.5);
    img.pixels[0] = [0.1, 0.1, 0.1]; // x=0, w=0 (no change)
    img.pixels[2] = [0.1, 0.1, 0.1]; // x=2, w=1 (contrast up)
    apply(&mut img, &layers);
    // For Y=0.1 < 0.18, +contrast should crush.
    assert!(img.pixels[2][0] < 0.1, "crushed: {}", img.pixels[2][0]);
    assert!((img.pixels[0][0] - 0.1).abs() < 1e-5);
}

#[test]
fn local_saturation_desaturates() {
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.0),
            end: Point2::new(1.0, 0.0),
            feather: 0.0,
        },
        adjustments: PartialAdjustments {
            saturation: Some(-100.0),
            ..Default::default()
        },
    }];
    let mut img = flat_image(2, 1, 0.5);
    img.pixels[1] = [0.8, 0.2, 0.2];
    apply(&mut img, &layers);
    // x=1 (w=1) — desaturated.
    let p = img.pixels[1];
    assert!((p[0] - p[1]).abs() < 1e-3);
    assert!((p[1] - p[2]).abs() < 1e-3);
}

#[test]
fn local_shadows_lift() {
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.0),
            end: Point2::new(1.0, 0.0),
            feather: 0.0,
        },
        adjustments: PartialAdjustments {
            shadows: Some(100.0),
            ..Default::default()
        },
    }];
    let mut img = flat_image(2, 1, 0.05);
    apply(&mut img, &layers);
    // x=1 (w=1) — lifted.
    assert!(img.pixels[1][0] > 0.05);
}

#[test]
fn local_blacks_additive_lift() {
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.0),
            end: Point2::new(1.0, 0.0),
            feather: 0.0,
        },
        adjustments: PartialAdjustments {
            blacks: Some(100.0),
            ..Default::default()
        },
    }];
    let mut img = flat_image(2, 1, 0.0);
    apply(&mut img, &layers);
    // x=1 (w=1) — additive lift from 0 should land at 100/400 = 0.25.
    assert!((img.pixels[1][0] - 0.25).abs() < 1e-5);
}

/// A single full-coverage layer (left edge w=0, right edge w=1) carrying
/// `adj`. Lets the directional tests read the w=1 (last) pixel.
fn full_mask_layer(adj: PartialAdjustments) -> Vec<LocalAdjustment> {
    vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.0),
            end: Point2::new(1.0, 0.0),
            feather: 0.0,
        },
        adjustments: adj,
    }]
}

#[test]
fn local_tint_pushes_magenta() {
    // tint+ = magenta image (white_balance docs). On a neutral pixel,
    // CAT16 with tint>0 should raise the magenta channels (R, B) relative
    // to green — i.e. green drops below R and B.
    let layers = full_mask_layer(PartialAdjustments {
        tint: Some(50.0),
        ..Default::default()
    });
    let mut img = flat_image(2, 1, 0.5);
    apply(&mut img, &layers);
    let p = img.pixels[1]; // w=1
    assert!(
        p[1] < p[0] && p[1] < p[2],
        "tint+ should push toward magenta (G below R,B): {p:?}"
    );
    // x=0 (w=0) — untouched.
    assert!((img.pixels[0][1] - 0.5).abs() < 1e-5);

    // And tint- should go the other way (green image: G above R,B).
    let layers_neg = full_mask_layer(PartialAdjustments {
        tint: Some(-50.0),
        ..Default::default()
    });
    let mut img2 = flat_image(2, 1, 0.5);
    apply(&mut img2, &layers_neg);
    let q = img2.pixels[1];
    assert!(
        q[1] > q[0] && q[1] > q[2],
        "tint- should push toward green (G above R,B): {q:?}"
    );
}

#[test]
fn local_highlights_reduce_bright_tones_and_stay_finite() {
    // +highlights compresses bright-but-unclipped tones downward. A pixel
    // at Y≈0.8 (inside the H_W0=0.25 engagement band) should darken.
    let layers = full_mask_layer(PartialAdjustments {
        highlights: Some(100.0),
        ..Default::default()
    });
    let mut img = flat_image(2, 1, 0.8);
    apply(&mut img, &layers);
    assert!(
        img.pixels[1][0] < 0.8,
        "+highlights should reduce Y≈0.8: {}",
        img.pixels[1][0]
    );
    // w=0 side untouched.
    assert!((img.pixels[0][0] - 0.8).abs() < 1e-5);

    // Above the Y=1 knee the multiplier must stay finite and pole-free on
    // BOTH signs (the #1081 mirror branch). Exercise a very bright pixel.
    for h in [100.0_f32, -100.0] {
        let l = full_mask_layer(PartialAdjustments {
            highlights: Some(h),
            ..Default::default()
        });
        let mut hi = flat_image(2, 1, 8.0); // well above the knee
        apply(&mut hi, &l);
        let v = hi.pixels[1][0];
        assert!(v.is_finite() && v > 0.0, "highlights={h} above knee: {v}");
    }
}

#[test]
fn local_whites_leave_midtones_and_ramp_toward_one() {
    // Whites are smoothstep(0.5, 1.0, Y)-weighted: Y≤0.5 is untouched and
    // the effect ramps up toward Y=1.
    let make = |start: f32| {
        let layers = full_mask_layer(PartialAdjustments {
            whites: Some(100.0),
            ..Default::default()
        });
        let mut img = flat_image(2, 1, start);
        apply(&mut img, &layers);
        img.pixels[1][0] // w=1 pixel
    };
    // Y=0.5: weight is exactly 0 → unchanged.
    assert!((make(0.5) - 0.5).abs() < 1e-5, "Y=0.5 should be untouched");
    // Y=0.4 (< 0.5): still untouched.
    assert!((make(0.4) - 0.4).abs() < 1e-5, "Y=0.4 should be untouched");
    // Y=0.75 (mid-band) gets some lift; Y=0.95 (near the top) gets more,
    // both in absolute delta and as a fraction — the ramp increases.
    let d75 = make(0.75) - 0.75;
    let d95 = make(0.95) - 0.95;
    assert!(d75 > 0.0, "Y=0.75 should lift: {d75}");
    assert!(d95 > d75, "lift should ramp up toward Y=1: {d75} -> {d95}");
}

#[test]
fn local_vibrance_boosts_low_chroma_more_and_spares_neutral() {
    let layers = full_mask_layer(PartialAdjustments {
        vibrance: Some(100.0),
        ..Default::default()
    });
    // Pixel 0: w=0 (untouched). Pixel 1: w=1, a near-neutral grey.
    let mut img = flat_image(2, 1, 0.5);
    apply(&mut img, &layers);
    // Near-neutral pixel stays neutral (chroma ~ 0 → no boost).
    let n = img.pixels[1];
    assert!(
        (n[0] - n[1]).abs() < 1e-4 && (n[1] - n[2]).abs() < 1e-4,
        "neutral pixel must stay neutral under vibrance: {n:?}"
    );

    // Low-chroma colour should gain MORE chroma than a high-chroma one.
    let chroma = |rgb: [f32; 3]| {
        let lab = crate::color::oklab::rec2020_to_oklab(rgb);
        (lab[1] * lab[1] + lab[2] * lab[2]).sqrt()
    };
    // Two same-hue (reddish) pixels: one low chroma, one high chroma.
    let low = [0.55, 0.45, 0.45];
    let high = [0.9, 0.1, 0.1];
    let c_low_in = chroma(low);
    let c_high_in = chroma(high);

    let mut img_low = flat_image(2, 1, 0.5);
    img_low.pixels[1] = low;
    apply(&mut img_low, &layers);
    let mut img_high = flat_image(2, 1, 0.5);
    img_high.pixels[1] = high;
    apply(&mut img_high, &layers);

    let gain_low = chroma(img_low.pixels[1]) / c_low_in;
    let gain_high = chroma(img_high.pixels[1]) / c_high_in;
    assert!(
        gain_low > gain_high,
        "vibrance must boost low chroma more than high: low {gain_low} vs high {gain_high}"
    );
}

#[test]
fn local_tone_controls_are_sequential() {
    // Two sliders in ONE layer must compose sequentially (each reads the
    // previous control's output), matching `scene_tone_controls`. A fused
    // single-luma gain would diverge; this locks the sequential contract.
    //
    // Highlights+100 then shadows+100 on a single mid-bright pixel: apply
    // them one-at-a-time in two stacked layers and compare to one layer
    // carrying both. With sequential per-pixel semantics the results match
    // (a stacked layer re-reads luma exactly like an in-layer next step).
    let both = full_mask_layer(PartialAdjustments {
        highlights: Some(80.0),
        shadows: Some(80.0),
        ..Default::default()
    });
    let stacked = vec![
        LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.0),
                end: Point2::new(1.0, 0.0),
                feather: 0.0,
            },
            adjustments: PartialAdjustments {
                highlights: Some(80.0),
                ..Default::default()
            },
        },
        LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.0),
                end: Point2::new(1.0, 0.0),
                feather: 0.0,
            },
            adjustments: PartialAdjustments {
                shadows: Some(80.0),
                ..Default::default()
            },
        },
    ];
    let mut a = flat_image(2, 1, 0.3);
    let mut b = flat_image(2, 1, 0.3);
    apply(&mut a, &both);
    apply(&mut b, &stacked);
    assert!(
        (a.pixels[1][0] - b.pixels[1][0]).abs() < 1e-5,
        "in-layer h+s must equal stacked h then s (sequential luma): {} vs {}",
        a.pixels[1][0],
        b.pixels[1][0]
    );
}

fn oklab_hue_deg(rgb: [f32; 3]) -> f32 {
    let lab = crate::color::oklab::rec2020_to_oklab(rgb);
    lab[2].atan2(lab[1]).to_degrees()
}

fn oklab_lc(rgb: [f32; 3]) -> (f32, f32) {
    let lab = crate::color::oklab::rec2020_to_oklab(rgb);
    (lab[0], (lab[1] * lab[1] + lab[2] * lab[2]).sqrt())
}

/// Signed circular hue delta in degrees, `(-180, 180]`.
fn hue_delta_deg(from: f32, to: f32) -> f32 {
    let mut d = to - from;
    while d > 180.0 {
        d -= 360.0;
    }
    while d <= -180.0 {
        d += 360.0;
    }
    d
}

#[test]
fn hue_100_rotates_oklab_hue_by_30_degrees_and_keeps_l_and_c() {
    // A mid-chroma orange, well inside the Rec.2020 hull at the rotated hue.
    let src = [0.45, 0.22, 0.08];
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.5),
        Point2::new(1.0, 0.5),
        PartialAdjustments {
            hue: Some(100.0),
            ..Default::default()
        },
    )];
    let mut img = Image {
        width: 3,
        height: 1,
        pixels: vec![src; 3],
        space: ColorSpace::SceneLinearRec2020,
    };
    apply(&mut img, &layers);
    // x=2 is the w=1 end of the gradient (feather 0.5 spans t 0.25..0.75).
    let out = img.pixels[2];
    let d = hue_delta_deg(oklab_hue_deg(src), oklab_hue_deg(out));
    assert!((d - 30.0).abs() < 0.5, "rotated by {d}°, expected 30°");
    let (l0, c0) = oklab_lc(src);
    let (l1, c1) = oklab_lc(out);
    assert!((l1 - l0).abs() < 1e-4, "L moved {l0} -> {l1}");
    assert!((c1 - c0).abs() < 1e-4, "C moved {c0} -> {c1}");
    // x=0 is the w=0 end: untouched.
    assert_eq!(img.pixels[0], src);
}

#[test]
fn hue_at_half_weight_rotates_15_degrees() {
    let src = [0.45, 0.22, 0.08];
    let layers = vec![LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(10.0, 10.0),
            angle: 0.0,
            feather: 0.0,
            invert: false,
        },
        adjustments: PartialAdjustments {
            hue: Some(50.0),
            ..Default::default()
        },
    }];
    let mut img = flat_image(2, 2, 0.0);
    img.pixels = vec![src; 4];
    apply(&mut img, &layers);
    let d = hue_delta_deg(oklab_hue_deg(src), oklab_hue_deg(img.pixels[0]));
    assert!((d - 15.0).abs() < 0.5, "rotated by {d}°, expected 15°");
}

#[test]
fn hue_leaves_a_pixel_below_the_chroma_gate_bit_identical() {
    // A pixel whose Oklab chroma is genuinely below the `1e-6` gate (a
    // uniform RGB value, not a Rec.2020 "grey": Rec.2020 (0.18,0.18,0.18)
    // itself carries ~1.08e-5 Oklab chroma from the primaries-matrix float32
    // round trip — see `hue_rotation_of_actual_grey_stays_within_a_tight_bound`
    // below, which pins that magnitude instead of pretending it's zero).
    // Constructing a pixel from L=0,a=0,b=0 directly (Rec.2020 black) sits
    // exactly at zero chroma with no such noise.
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.5),
        Point2::new(1.0, 0.5),
        PartialAdjustments {
            hue: Some(100.0),
            ..Default::default()
        },
    )];
    let mut img = flat_image(4, 1, 0.0);
    let snapshot = img.pixels.clone();
    apply(&mut img, &layers);
    assert_eq!(img.pixels, snapshot);
}

#[test]
fn hue_rotation_of_actual_grey_stays_within_a_tight_numerical_bound() {
    // Rec.2020 grey carries a tiny (~1e-5) Oklab chroma from the primaries
    // matrix's float32 round trip (the same noise floor `saturation::apply`'s
    // identical `c_in < 1e-6` gate already tolerates) — so it is NOT bit-
    // identical after a rotation, but the drift must stay far below anything
    // visible: a rotation can only ever move a pixel by an amount
    // proportional to its own chroma, never amplify it.
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.5),
        Point2::new(1.0, 0.5),
        PartialAdjustments {
            hue: Some(100.0),
            ..Default::default()
        },
    )];
    let mut img = flat_image(4, 1, 0.18);
    let snapshot = img.pixels.clone();
    apply(&mut img, &layers);
    for (out, before) in img.pixels.iter().zip(&snapshot) {
        for c in 0..3 {
            assert!(
                (out[c] - before[c]).abs() < 1e-4,
                "grey drifted too far: {before:?} -> {out:?}"
            );
        }
    }
}

#[test]
fn hue_rotation_keeps_every_channel_non_negative_near_the_hull() {
    // A saturated Rec.2020 red sits on the hull; rotating it toward yellow
    // lands on a narrower part of the hull, which is exactly the case the
    // soft knee exists for.
    let src = [0.9, 0.02, 0.01];
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.5),
        Point2::new(1.0, 0.5),
        PartialAdjustments {
            hue: Some(100.0),
            ..Default::default()
        },
    )];
    let mut img = flat_image(3, 1, 0.0);
    img.pixels = vec![src; 3];
    apply(&mut img, &layers);
    let out = img.pixels[2];
    assert!(out.iter().all(|c| *c >= -1e-5), "negative channel: {out:?}");
}
