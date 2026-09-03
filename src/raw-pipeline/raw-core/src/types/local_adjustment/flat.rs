//! Flat `f32` serialization of a local-adjustment layer stack (#1698).
//!
//! One layout serves two consumers that must agree byte-for-byte:
//!
//! * the **FFI / WASM wire** — a `(ptr, len)` f32 array on
//!   `MapleAdjustmentParams` (CPU chain) and `MapleGpuLiveParams` (GPU live
//!   chain), following the same append-only convention every other
//!   variable-length field on those structs uses, and
//! * the **GPU storage buffer** — `raw-gpu`'s `local_adjustments.wgsl` binds
//!   this exact array as `array<Layer>`, where `Layer` is eight `vec4<f32>`
//!   members. That is why the stride is 32 floats (128 bytes) with explicit
//!   padding slots rather than a tight 31: WGSL gives a `vec4<f32>` a 16-byte
//!   alignment, so a struct of eight of them has no interior padding only at
//!   this stride.
//!
//! ## Slot map (per layer, [`LAYER_FLAT_LEN`] floats)
//!
//! ```text
//!  0..2   p0        Linear: start (x, y)      Radial: center (x, y)
//!  2..4   p1        Linear: end   (x, y)      Radial: radii  (rx, ry)
//!  4      feather
//!  5      angle     Radial only; 0 for Linear
//!  6      kind      KIND_LINEAR (0) | KIND_RADIAL (1)
//!  7      invert    Radial only; 0 or 1
//!  8      present   presence bitmask, see below
//!  9..12  (padding, written as 0)
//! 12..16  exposure, contrast, highlights, shadows
//! 16..20  whites, blacks, saturation, vibrance
//! 20..22  temperature, tint
//! 22     hue        Oklab hue rotation (#3269), presence bit 10
//! 23     (padding, written as 0)
//! 24     range_kind RANGE_KIND_NONE (0) | RANGE_KIND_COLOR (1) — #3270
//! 25..31  hue_deg, hue_half_width_deg, chroma_min, l_min, l_max, feather
//! 31     (padding, written as 0)
//! ```
//!
//! ## Why a presence bitmask rather than a sentinel value
//!
//! Every field of `PartialAdjustments` is an `Option<f32>`, and `None` is NOT
//! the same as `Some(0.0)` for four of the nine controls: `saturation(0)` and
//! `vibrance(0)` still round-trip the pixel through Oklab (which is not a
//! bit-exact identity), and `temperature`/`tint` being present at all engages
//! a CAT16 matrix that sits ~6.9e-3 off identity even at the D65 anchor. A
//! sentinel would silently turn "not set" into a visible colour shift, so
//! presence is carried explicitly.
//!
//! The mask rides an `f32` slot rather than a bitcast `u32` so the array stays
//! a plain float wire on both the C ABI and the WGSL side (WGSL would need a
//! `bitcast<u32>` otherwise, and the C header would carry a lane whose
//! interpretation depends on the reader). The mask never exceeds 2047, and an
//! `f32` represents every integer below 2²⁴ exactly, so the round trip through
//! the float slot is lossless.

use super::{LocalAdjustment, Mask, PartialAdjustments, Point2, RangeRefinement};

/// Floats per serialized layer. Eight WGSL `vec4<f32>` members = 128 bytes.
pub const LAYER_FLAT_LEN: usize = 32;

/// `kind` slot value for [`Mask::Linear`].
pub const KIND_LINEAR: f32 = 0.0;
/// `kind` slot value for [`Mask::Radial`].
pub const KIND_RADIAL: f32 = 1.0;

/// `range_kind` slot value for "no range refinement."
pub const RANGE_KIND_NONE: f32 = 0.0;
/// `range_kind` slot value for [`RangeRefinement::Color`].
pub const RANGE_KIND_COLOR: f32 = 1.0;

/// Presence bits, in the field order the `adj*` slots use. Bit `i` set means
/// slot `12 + i` carries a real value; clear means the control is `None` and
/// the apply stage must skip it entirely.
pub const PRESENT_EXPOSURE: u32 = 1 << 0;
pub const PRESENT_CONTRAST: u32 = 1 << 1;
pub const PRESENT_HIGHLIGHTS: u32 = 1 << 2;
pub const PRESENT_SHADOWS: u32 = 1 << 3;
pub const PRESENT_WHITES: u32 = 1 << 4;
pub const PRESENT_BLACKS: u32 = 1 << 5;
pub const PRESENT_SATURATION: u32 = 1 << 6;
pub const PRESENT_VIBRANCE: u32 = 1 << 7;
pub const PRESENT_TEMPERATURE: u32 = 1 << 8;
pub const PRESENT_TINT: u32 = 1 << 9;
pub const PRESENT_HUE: u32 = 1 << 10;

/// Serialize a layer stack to the flat wire. The result length is always
/// `layers.len() * LAYER_FLAT_LEN`; an empty stack yields an empty `Vec`.
pub fn layers_to_flat(layers: &[LocalAdjustment]) -> Vec<f32> {
    let mut out = vec![0.0f32; layers.len() * LAYER_FLAT_LEN];
    for (layer, slot) in layers.iter().zip(out.chunks_exact_mut(LAYER_FLAT_LEN)) {
        write_mask(&layer.mask, slot);
        write_adjustments(&layer.adjustments, slot);
        write_range(layer.range, slot);
    }
    out
}

fn write_range(range: Option<RangeRefinement>, slot: &mut [f32]) {
    match range {
        None => slot[24] = RANGE_KIND_NONE,
        Some(RangeRefinement::Color {
            hue_deg,
            hue_half_width_deg,
            chroma_min,
            l_min,
            l_max,
            feather,
        }) => {
            slot[24] = RANGE_KIND_COLOR;
            slot[25] = hue_deg;
            slot[26] = hue_half_width_deg;
            slot[27] = chroma_min;
            slot[28] = l_min;
            slot[29] = l_max;
            slot[30] = feather;
        }
    }
}

fn read_range(slot: &[f32]) -> Option<RangeRefinement> {
    if slot[24] == RANGE_KIND_COLOR {
        Some(RangeRefinement::Color {
            hue_deg: slot[25],
            hue_half_width_deg: slot[26],
            chroma_min: slot[27],
            l_min: slot[28],
            l_max: slot[29],
            feather: slot[30],
        })
    } else {
        None
    }
}

fn write_mask(mask: &Mask, slot: &mut [f32]) {
    match *mask {
        Mask::Linear {
            start,
            end,
            feather,
        } => {
            slot[0] = start.x;
            slot[1] = start.y;
            slot[2] = end.x;
            slot[3] = end.y;
            slot[4] = feather;
            slot[6] = KIND_LINEAR;
        }
        Mask::Radial {
            center,
            radii,
            angle,
            feather,
            invert,
        } => {
            slot[0] = center.x;
            slot[1] = center.y;
            slot[2] = radii.x;
            slot[3] = radii.y;
            slot[4] = feather;
            slot[5] = angle;
            slot[6] = KIND_RADIAL;
            slot[7] = if invert { 1.0 } else { 0.0 };
        }
    }
}

fn write_adjustments(a: &PartialAdjustments, slot: &mut [f32]) {
    let fields = [
        (a.exposure, PRESENT_EXPOSURE),
        (a.contrast, PRESENT_CONTRAST),
        (a.highlights, PRESENT_HIGHLIGHTS),
        (a.shadows, PRESENT_SHADOWS),
        (a.whites, PRESENT_WHITES),
        (a.blacks, PRESENT_BLACKS),
        (a.saturation, PRESENT_SATURATION),
        (a.vibrance, PRESENT_VIBRANCE),
        (a.temperature, PRESENT_TEMPERATURE),
        (a.tint, PRESENT_TINT),
    ];
    let mut present = fields
        .iter()
        .filter_map(|&(value, bit)| value.map(|_| bit))
        .fold(0u32, |acc, bit| acc | bit);
    if a.hue.is_some() {
        present |= PRESENT_HUE;
    }
    slot[8] = present as f32;
    for (i, &(value, _)) in fields.iter().enumerate() {
        slot[12 + i] = value.unwrap_or(0.0);
    }
    slot[22] = a.hue.unwrap_or(0.0);
}

/// Deserialize the flat wire back into a layer stack. A trailing partial layer
/// (`flat.len()` not a multiple of [`LAYER_FLAT_LEN`]) is dropped rather than
/// rejected, so a truncated host buffer degrades to the layers it did carry
/// instead of failing the whole render. An unknown `kind` value falls back to
/// [`Mask::Linear`], matching the C-ABI convention that an unrecognised
/// discriminant resolves to the zero variant.
pub fn layers_from_flat(flat: &[f32]) -> Vec<LocalAdjustment> {
    flat.chunks_exact(LAYER_FLAT_LEN)
        .map(|slot| LocalAdjustment {
            mask: read_mask(slot),
            range: read_range(slot),
            adjustments: read_adjustments(slot),
        })
        .collect()
}

fn read_mask(slot: &[f32]) -> Mask {
    if slot[6] == KIND_RADIAL {
        Mask::Radial {
            center: Point2::new(slot[0], slot[1]),
            radii: Point2::new(slot[2], slot[3]),
            angle: slot[5],
            feather: slot[4],
            invert: slot[7] != 0.0,
        }
    } else {
        Mask::Linear {
            start: Point2::new(slot[0], slot[1]),
            end: Point2::new(slot[2], slot[3]),
            feather: slot[4],
        }
    }
}

fn read_adjustments(slot: &[f32]) -> PartialAdjustments {
    // `as u32` on a float saturates rather than wrapping in Rust, and the
    // encoder only ever writes an exact small integer here, so a corrupt or
    // zeroed slot reads as "nothing present" instead of a nonsense mask.
    let present = slot[8] as u32;
    let field = |i: usize, bit: u32| {
        if present & bit != 0 {
            Some(slot[12 + i])
        } else {
            None
        }
    };
    PartialAdjustments {
        exposure: field(0, PRESENT_EXPOSURE),
        contrast: field(1, PRESENT_CONTRAST),
        highlights: field(2, PRESENT_HIGHLIGHTS),
        shadows: field(3, PRESENT_SHADOWS),
        whites: field(4, PRESENT_WHITES),
        blacks: field(5, PRESENT_BLACKS),
        saturation: field(6, PRESENT_SATURATION),
        vibrance: field(7, PRESENT_VIBRANCE),
        temperature: field(8, PRESENT_TEMPERATURE),
        tint: field(9, PRESENT_TINT),
        hue: if present & PRESENT_HUE != 0 {
            Some(slot[22])
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_controls() -> PartialAdjustments {
        PartialAdjustments {
            exposure: Some(0.75),
            contrast: Some(-30.0),
            highlights: Some(45.0),
            shadows: Some(-12.5),
            whites: Some(8.0),
            blacks: Some(-60.0),
            saturation: Some(22.0),
            vibrance: Some(-5.0),
            temperature: Some(1500.0),
            tint: Some(-9.0),
            hue: Some(12.0),
        }
    }

    #[test]
    fn hue_rides_slot_22_with_presence_bit_10() {
        let layers = vec![LocalAdjustment::linear(
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            PartialAdjustments {
                hue: Some(-42.5),
                ..Default::default()
            },
        )];
        let flat = layers_to_flat(&layers);
        assert_eq!(flat[22], -42.5);
        assert_eq!(flat[8] as u32, PRESENT_HUE);
        assert_eq!(layers_from_flat(&flat)[0].adjustments.hue, Some(-42.5));
    }

    #[test]
    fn linear_layer_round_trips() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.125, 0.25),
                end: Point2::new(0.875, 0.75),
                feather: 0.375,
            },
            range: None,
            adjustments: all_controls(),
        }];
        let flat = layers_to_flat(&layers);
        assert_eq!(flat.len(), LAYER_FLAT_LEN);
        assert_eq!(layers_from_flat(&flat), layers);
    }

    #[test]
    fn radial_layer_round_trips_including_invert_and_angle() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Radial {
                center: Point2::new(0.4, 0.6),
                radii: Point2::new(0.3, 0.2),
                angle: 1.25,
                feather: 0.5,
                invert: true,
            },
            range: None,
            adjustments: all_controls(),
        }];
        let flat = layers_to_flat(&layers);
        assert_eq!(layers_from_flat(&flat), layers);
    }

    #[test]
    fn absent_controls_stay_absent_and_are_distinct_from_zero() {
        let sparse = PartialAdjustments {
            saturation: Some(0.0),
            ..Default::default()
        };
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.0),
                end: Point2::new(1.0, 1.0),
                feather: 0.5,
            },
            range: None,
            adjustments: sparse,
        }];
        let back = layers_from_flat(&layers_to_flat(&layers));
        assert_eq!(back[0].adjustments.saturation, Some(0.0));
        assert_eq!(back[0].adjustments.vibrance, None);
        assert_eq!(back[0].adjustments.exposure, None);
        assert_eq!(back[0].adjustments.temperature, None);
    }

    #[test]
    fn presence_mask_is_exactly_representable_when_every_field_is_set() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.5),
                end: Point2::new(1.0, 0.5),
                feather: 0.0,
            },
            range: None,
            adjustments: all_controls(),
        }];
        let flat = layers_to_flat(&layers);
        assert_eq!(flat[8], 2047.0);
        assert_eq!(flat[8] as u32, 2047);
    }

    #[test]
    fn multiple_layers_keep_their_order() {
        let layers = vec![
            LocalAdjustment::linear(
                Point2::new(0.0, 0.0),
                Point2::new(1.0, 0.0),
                PartialAdjustments {
                    exposure: Some(1.0),
                    ..Default::default()
                },
            ),
            LocalAdjustment::radial(
                Point2::new(0.5, 0.5),
                Point2::new(0.2, 0.2),
                PartialAdjustments {
                    exposure: Some(-1.0),
                    ..Default::default()
                },
            ),
        ];
        let back = layers_from_flat(&layers_to_flat(&layers));
        assert_eq!(back, layers);
    }

    #[test]
    fn empty_stack_serializes_to_an_empty_wire() {
        assert!(layers_to_flat(&[]).is_empty());
        assert!(layers_from_flat(&[]).is_empty());
    }

    #[test]
    fn truncated_wire_drops_the_partial_tail_layer() {
        let layers = vec![LocalAdjustment::linear(
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
        )];
        let mut flat = layers_to_flat(&layers);
        flat.extend_from_slice(&[0.0; 5]);
        assert_eq!(layers_from_flat(&flat).len(), 1);
    }

    #[test]
    fn record_is_32_floats_and_range_rides_slots_24_to_30() {
        let mut layer = LocalAdjustment::linear(
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            PartialAdjustments {
                exposure: Some(0.5),
                ..Default::default()
            },
        );
        layer.range = Some(RangeRefinement::Color {
            hue_deg: 55.0,
            hue_half_width_deg: 25.0,
            chroma_min: 0.02,
            l_min: 0.15,
            l_max: 0.95,
            feather: 0.3,
        });
        let flat = layers_to_flat(&[layer.clone()]);
        assert_eq!(LAYER_FLAT_LEN, 32);
        assert_eq!(flat.len(), 32);
        assert_eq!(&flat[24..31], &[1.0, 55.0, 25.0, 0.02, 0.15, 0.95, 0.3]);
        assert_eq!(layers_from_flat(&flat), vec![layer]);
    }

    #[test]
    fn absent_range_reads_back_as_none() {
        let layer = LocalAdjustment::linear(
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            PartialAdjustments::default(),
        );
        let flat = layers_to_flat(&[layer]);
        assert_eq!(flat[24], RANGE_KIND_NONE);
        assert_eq!(layers_from_flat(&flat)[0].range, None);
    }
}
