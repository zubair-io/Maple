use super::*;

const W: usize = 24;
const H: usize = 16;
const BLACK: [u32; 4] = [512; 4];
const WHITE: u32 = 16000;

fn area(declared: bool) -> ActiveArea {
    ActiveArea {
        left: 6,
        top: 4,
        width: 14,
        height: 10,
        declared,
    }
}

fn inside(x: usize, y: usize) -> bool {
    let a = area(true);
    (a.left..a.left + a.width).contains(&x) && (a.top..a.top + a.height).contains(&y)
}

/// A scene inside the active area, `margin` everywhere else.
fn frame(margin: u16) -> Vec<u16> {
    (0..W * H)
        .map(|i| {
            let (x, y) = (i % W, i / W);
            if inside(x, y) {
                1000 + (x * 37 + y * 101 + (x & 1) * 900 + (y & 1) * 400) as u16
            } else {
                margin
            }
        })
        .collect()
}

#[test]
fn a_declared_margin_poisoned_at_white_refills_like_a_black_one() {
    let refill = |margin| {
        refill_masked_margins(
            frame(margin),
            W,
            H,
            &CfaPattern::Rggb,
            Some(area(true)),
            &BLACK,
            WHITE,
        )
    };
    let (from_black, from_white) = (refill(512), refill(16000));
    assert_eq!(from_black, from_white);
    assert!(
        (0..W * H)
            .filter(|&i| inside(i % W, i / W))
            .all(|i| from_black[i] == frame(512)[i]),
        "active samples are untouched"
    );
}

#[test]
fn refilled_samples_copy_the_nearest_active_sample_of_the_same_phase() {
    let out = refill_masked_margins(
        frame(512),
        W,
        H,
        &CfaPattern::Rggb,
        Some(area(false)),
        &BLACK,
        WHITE,
    );
    let src = frame(512);
    let a = area(false);
    let near = |v: usize, lo: usize, hi: usize| {
        let candidates = lo..hi;
        candidates
            .filter(|c| c % 2 == v % 2)
            .min_by_key(|c| c.abs_diff(v))
            .unwrap()
    };
    for y in 0..H {
        for x in 0..W {
            let (sx, sy) = (
                near(x, a.left, a.left + a.width),
                near(y, a.top, a.top + a.height),
            );
            assert_eq!(out[y * W + x], src[sy * W + sx], "({x}, {y})");
        }
    }
}

#[test]
fn an_undeclared_margin_holding_image_data_is_left_alone() {
    let bright = frame(9000);
    let out = refill_masked_margins(
        bright.clone(),
        W,
        H,
        &CfaPattern::Rggb,
        Some(area(false)),
        &BLACK,
        WHITE,
    );
    assert_eq!(out, bright);
}

#[test]
fn x_trans_refill_keeps_the_six_by_six_phase() {
    let pattern = [0u8; 36];
    let a = ActiveArea {
        left: 7,
        top: 6,
        width: 12,
        height: 7,
        declared: true,
    };
    let src: Vec<u16> = (0..W * H).map(|i| i as u16).collect();
    let out = refill_masked_margins(
        src.clone(),
        W,
        H,
        &CfaPattern::XTrans(pattern),
        Some(a),
        &BLACK,
        WHITE,
    );
    for y in 0..H {
        for x in 0..W {
            let v = usize::from(out[y * W + x]);
            let (sx, sy) = (v % W, v / W);
            assert_eq!(
                (sx % 6, sy % 6),
                (x % 6, y % 6),
                "({x}, {y}) took ({sx}, {sy})"
            );
            assert!(
                (a.left..a.left + a.width).contains(&sx) && (a.top..a.top + a.height).contains(&sy)
            );
        }
    }
}

#[test]
fn linear_rgb_and_missing_areas_pass_through() {
    let src = frame(512);
    assert_eq!(
        refill_masked_margins(
            src.clone(),
            W,
            H,
            &CfaPattern::LinearRgb,
            Some(area(true)),
            &BLACK,
            WHITE
        ),
        src
    );
    assert_eq!(
        refill_masked_margins(src.clone(), W, H, &CfaPattern::Rggb, None, &BLACK, WHITE),
        src
    );
}

#[test]
fn the_content_gate_uses_the_highest_per_phase_black() {
    let black = [500, 510, 520, 530];
    let margin_at = |level| frame(level);
    let refill = |data| {
        refill_masked_margins(
            data,
            W,
            H,
            &CfaPattern::Rggb,
            Some(area(false)),
            &black,
            WHITE,
        )
    };
    assert_ne!(
        refill(margin_at(530)),
        margin_at(530),
        "at the highest black: masked"
    );
    let above = 530 + (WHITE - 530) / 100 + 1;
    assert_eq!(
        refill(margin_at(above as u16)),
        margin_at(above as u16),
        "above tolerance: kept"
    );
}
