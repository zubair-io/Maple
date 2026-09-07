//! Flat `f32` serialization of a local-adjustment layer stack (#1698).
//!
//! One layout serves two consumers that must agree byte-for-byte:
//!
//! * the **FFI / WASM wire** — a `(ptr, len)` f32 array on
//!   `MapleAdjustmentParams` (CPU chain) and `MapleGpuLiveParams` (GPU live
//!   chain), following the same append-only convention every other
//!   variable-length field on those structs uses, and
//! * the **GPU storage buffer** — `raw-gpu`'s `local_adjustments.wgsl` binds
//!   this exact array as `array<Layer>`, where `Layer` is ten `vec4<f32>`
//!   members. That is why the stride is 40 floats (160 bytes) with explicit
//!   padding slots rather than a tight 38: WGSL gives a `vec4<f32>` a 16-byte
//!   alignment, so a struct of ten of them has no interior padding only at
//!   this stride.
//!
//! The map is APPEND-ONLY: the six spatial controls (#3407) took a new
//! `vec4` pair at the tail rather than the interior padding slots, so every
//! slot an earlier reader knows keeps its meaning.
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
//! 32..36 texture, clarity, dehaze, sharpness       presence bits 11..14
//! 36..38 luminance_noise, defringe                 presence bits 15..16
//! 38..40 (padding, written as 0)
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

use super::{
    BitmapRecipe, LocalAdjustment, Mask, MaskRaster, PartialAdjustments, Point2, RangeRefinement,
};
use std::sync::Arc;

/// Floats per serialized layer. Ten WGSL `vec4<f32>` members = 160 bytes.
pub const LAYER_FLAT_LEN: usize = 40;

/// `kind` slot value for [`Mask::Linear`].
pub const KIND_LINEAR: f32 = 0.0;
/// `kind` slot value for [`Mask::Radial`].
pub const KIND_RADIAL: f32 = 1.0;
/// `kind` slot value for [`Mask::Bitmap`] (#3271).
pub const KIND_BITMAP: f32 = 2.0;
/// `kind` slot value for [`Mask::Everywhere`] (#3271).
pub const KIND_EVERYWHERE: f32 = 3.0;

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
/// Spatial controls (#3407) — slots 32..38, in this order.
pub const PRESENT_TEXTURE: u32 = 1 << 11;
pub const PRESENT_CLARITY: u32 = 1 << 12;
pub const PRESENT_DEHAZE: u32 = 1 << 13;
pub const PRESENT_SHARPNESS: u32 = 1 << 14;
pub const PRESENT_LUMINANCE_NOISE: u32 = 1 << 15;
pub const PRESENT_DEFRINGE: u32 = 1 << 16;

/// Slot index of the first spatial control (`texture`).
const SPATIAL_BASE: usize = 32;

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
        Mask::Bitmap { raster_id, .. } => {
            // Only the id rides the flat wire — the recipe's other fields
            // (person/facial/body/model/digest) are UI + sidecar concerns,
            // not render-time inputs; the resolved MaskRaster (looked up by
            // this id) is what `stages::local_adjustments` actually samples.
            slot[2] = raster_id as f32;
            slot[6] = KIND_BITMAP;
        }
        Mask::Everywhere => {
            slot[6] = KIND_EVERYWHERE;
        }
    }
}

/// The ten point controls that ride the contiguous `12..22` block, paired
/// with their presence bits — one list so the writer and the reader below
/// cannot disagree about which slot holds which control.
fn point_fields(a: &PartialAdjustments) -> [(Option<f32>, u32); 10] {
    [
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
    ]
}

/// The six spatial controls (#3407) on the `32..38` block, same convention.
fn spatial_fields(a: &PartialAdjustments) -> [(Option<f32>, u32); 6] {
    [
        (a.texture, PRESENT_TEXTURE),
        (a.clarity, PRESENT_CLARITY),
        (a.dehaze, PRESENT_DEHAZE),
        (a.sharpness, PRESENT_SHARPNESS),
        (a.luminance_noise, PRESENT_LUMINANCE_NOISE),
        (a.defringe, PRESENT_DEFRINGE),
    ]
}

fn write_adjustments(a: &PartialAdjustments, slot: &mut [f32]) {
    let point = point_fields(a);
    let spatial = spatial_fields(a);
    let bits = |acc: u32, &(value, bit): &(Option<f32>, u32)| match value {
        Some(_) => acc | bit,
        None => acc,
    };
    let present = spatial.iter().fold(
        point
            .iter()
            .fold(if a.hue.is_some() { PRESENT_HUE } else { 0 }, bits),
        bits,
    );
    slot[8] = present as f32;
    for (i, &(value, _)) in point.iter().enumerate() {
        slot[12 + i] = value.unwrap_or(0.0);
    }
    slot[22] = a.hue.unwrap_or(0.0);
    for (i, &(value, _)) in spatial.iter().enumerate() {
        slot[SPATIAL_BASE + i] = value.unwrap_or(0.0);
    }
}

/// Deserialize the flat wire back into a layer stack. A trailing partial layer
/// (`flat.len()` not a multiple of [`LAYER_FLAT_LEN`]) is dropped rather than
/// rejected, so a truncated host buffer degrades to the layers it did carry
/// instead of failing the whole render. An unknown `kind` value falls back to
/// [`Mask::Linear`], matching the C-ABI convention that an unrecognised
/// discriminant resolves to the zero variant.
///
/// `rasters` resolves a `Mask::Bitmap` slot's `raster_id` to the recipe
/// digest it reports (#3271) — pass `&[]` when the caller has no bitmap
/// masks registered; the reconstructed layer still carries the raw
/// `raster_id`, so later `stages::local_adjustments::mask::resolve` calls
/// against the SAME (or a fuller) `rasters` slice still work even if this
/// pass didn't have the raster available.
pub fn layers_from_flat(flat: &[f32], rasters: &[Arc<MaskRaster>]) -> Vec<LocalAdjustment> {
    flat.chunks_exact(LAYER_FLAT_LEN)
        .map(|slot| LocalAdjustment {
            mask: read_mask(slot, rasters),
            range: read_range(slot),
            adjustments: read_adjustments(slot),
        })
        .collect()
}

fn read_mask(slot: &[f32], rasters: &[Arc<MaskRaster>]) -> Mask {
    if slot[6] == KIND_EVERYWHERE {
        return Mask::Everywhere;
    }
    if slot[6] == KIND_BITMAP {
        let raster_id = slot[2] as u32;
        let digest = rasters
            .iter()
            .find(|r| r.id == raster_id)
            .map(|r| r.digest.clone())
            .unwrap_or_default();
        return Mask::Bitmap {
            recipe: BitmapRecipe {
                digest,
                ..Default::default()
            },
            raster_id,
        };
    }
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
    let spatial = |i: usize, bit: u32| {
        if present & bit != 0 {
            Some(slot[SPATIAL_BASE + i])
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
        texture: spatial(0, PRESENT_TEXTURE),
        clarity: spatial(1, PRESENT_CLARITY),
        dehaze: spatial(2, PRESENT_DEHAZE),
        sharpness: spatial(3, PRESENT_SHARPNESS),
        luminance_noise: spatial(4, PRESENT_LUMINANCE_NOISE),
        defringe: spatial(5, PRESENT_DEFRINGE),
    }
}

#[cfg(test)]
#[path = "flat_tests.rs"]
mod tests;
