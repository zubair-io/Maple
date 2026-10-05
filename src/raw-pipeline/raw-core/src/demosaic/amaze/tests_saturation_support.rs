use super::{
    green,
    scratch::{Scratch, Tile, TS},
};
use crate::image::CfaPattern;
#[test]
fn saturation_bound_preserves_supported_positive_sensor_transport() {
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0u8, 2] {
            for exposure in [0.01f32, 0.1, 1.0, 4.0] {
                let (x, y) = (16..20)
                    .flat_map(|y| (16..20).map(move |x| (x, y)))
                    .find(|&(x, y)| pattern.color_at(x as u32, y as u32) == channel)
                    .unwrap();
                let mut s = Scratch::new();
                for yy in 0..TS {
                    for xx in 0..TS {
                        let i = yy * TS + xx;
                        s.cfa[i] = if pattern.color_at(xx as u32, yy as u32) == 1 {
                            exposure
                        } else {
                            0.4 * exposure
                        };
                    }
                }
                let i = y * TS + x;
                s.cfa[i] = 0.8 * exposure;
                // Piecewise-linear same-chromaticity tent: measured C at ±2
                // is .4, centre C .8, measured G at ±1 is 1. The positive
                // half-step transport therefore supports centre G=4/3.
                let expected = (4.0 / 3.0) * exposure;
                s.hcd[i] = expected - s.cfa[i];
                s.vcd[i] = expected - s.cfa[i];
                let sampled = s.cfa.clone();
                green::median_bound(
                    &mut s,
                    &Tile {
                        top: 0,
                        left: 0,
                        rr1: TS,
                        cc1: TS,
                    },
                    pattern,
                );
                for actual in [s.hcd[i] + s.cfa[i], s.vcd[i] + s.cfa[i]] {
                    assert!((actual-expected).abs()<2e-6*exposure,"{pattern:?} channel={channel} exposure={exposure} actual={actual} expected={expected}");
                }
                assert_eq!(s.cfa, sampled);
            }
        }
    }
}

#[test]
fn saturation_bound_retains_median_without_positive_sensor_evidence() {
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0u8, 2] {
            for exposure in [1.0f32, 4.0] {
                let (x, y) = (16..20)
                    .flat_map(|y| (16..20).map(move |x| (x, y)))
                    .find(|&(x, y)| pattern.color_at(x as u32, y as u32) == channel)
                    .unwrap();
                for missing in [0.0f32, -0.1, f32::INFINITY, f32::NAN] {
                    let mut s = Scratch::new();
                    let i = y * TS + x;
                    s.cfa.fill(0.4 * exposure);
                    s.cfa[i] = if missing == 0.0 { 0.0 } else { 0.8 * exposure };
                    for stride in [1usize, TS] {
                        s.cfa[i - stride] = 0.3 * exposure;
                        s.cfa[i + stride] = 0.9 * exposure;
                        s.cfa[i - 2 * stride] = missing * exposure;
                    }
                    s.hcd[i] = 1.2 * exposure - s.cfa[i];
                    s.vcd[i] = 1.2 * exposure - s.cfa[i];
                    green::median_bound(
                        &mut s,
                        &Tile {
                            top: 0,
                            left: 0,
                            rr1: TS,
                            cc1: TS,
                        },
                        pattern,
                    );
                    for actual in [s.hcd[i] + s.cfa[i], s.vcd[i] + s.cfa[i]] {
                        assert!(
                            (actual - 0.9 * exposure).abs() < 2e-6 * exposure,
                            "{pattern:?} channel={channel} missing={missing} actual={actual}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn directional_clipping_does_not_extrapolate_across_unclipped_green_edge() {
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0u8, 2] {
            for exposure in [1.0f32, 4.0] {
                let (x, y) = (16..20)
                    .flat_map(|y| (16..20).map(move |x| (x, y)))
                    .find(|&(x, y)| pattern.color_at(x as u32, y as u32) == channel)
                    .unwrap();
                for offset in [-1isize, 1, -(TS as isize), TS as isize] {
                    let mut s = Scratch::new();
                    for yy in 0..TS {
                        for xx in 0..TS {
                            s.cfa[yy * TS + xx] = if pattern.color_at(xx as u32, yy as u32) == 1 {
                                exposure
                            } else {
                                0.4 * exposure
                            };
                        }
                    }
                    let i = y * TS + x;
                    s.cfa[i] = 0.8 * exposure;
                    s.cfa[(i as isize + offset) as usize] = 0.1 * exposure;
                    s.hcd[i] = (4.0 / 3.0) * exposure - s.cfa[i];
                    s.vcd[i] = s.hcd[i];
                    let sampled = s.cfa.clone();
                    green::median_bound(
                        &mut s,
                        &Tile {
                            top: 0,
                            left: 0,
                            rr1: TS,
                            cc1: TS,
                        },
                        pattern,
                    );
                    for value in [s.hcd[i] + s.cfa[i], s.vcd[i] + s.cfa[i]] {
                        assert!(
                            (value - exposure).abs() < 2e-6 * exposure,
                            "{pattern:?} c={channel} e={exposure} offset={offset} actual={value}"
                        );
                    }
                    assert_eq!(s.cfa, sampled);
                }
            }
        }
    }
}

#[test]
fn underflowed_sensor_support_keeps_existing_median() {
    let mut s = Scratch::new();
    let i = 16 * TS + 16;
    s.cfa.fill(0.0);
    s.cfa[i] = f32::from_bits(1);
    for o in [-1isize, 1, -(TS as isize), TS as isize] {
        s.cfa[(i as isize + o) as usize] = 1.0;
    }
    s.hcd[i] = 1.2;
    s.vcd[i] = 1.2;
    green::median_bound(
        &mut s,
        &Tile {
            top: 0,
            left: 0,
            rr1: TS,
            cc1: TS,
        },
        CfaPattern::Rggb,
    );
    assert_eq!(s.hcd[i] + s.cfa[i], 1.0);
    assert_eq!(s.vcd[i] + s.cfa[i], 1.0);
}
