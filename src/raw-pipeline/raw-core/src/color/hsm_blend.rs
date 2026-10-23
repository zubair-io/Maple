//! The reciprocal-CCT blend of two same-shape HueSatMaps, evaluated without
//! materialising the blended table, and its inverse — what the live
//! white-balance drag runs per pixel (#5099, `stages::wb_camera`).

use super::{
    apply_one_with, entry, hsv_to_rgb, linear_to_srgb_one, lookup_with, rgb_to_hsv,
    srgb_to_linear_one, HsmEncoding,
};

/// [`apply_one`] against the reciprocal-CCT blend of two same-shape tables at
/// weight `t` (0 = `cold`, 1 = `warm`) without materialising the blended
/// table: corresponding lattice entries are blended first, hue along the
/// shorter arc, before spatial interpolation, exactly as [`lerp_tables`].
/// Both slices are laid out as [`HsmTable::data`] for `dims`.
#[inline]
pub fn apply_one_blended(
    p: [f32; 3],
    dims: [u32; 3],
    encoding: HsmEncoding,
    tables: (&[f32], &[f32]),
    t: f32,
) -> [f32; 3] {
    apply_one_with(p, encoding, |h, s, v| {
        lookup_blended(dims, tables, t, h, s, v)
    })
}

/// The pre-image of `y` under [`apply_one_blended`], solved in HSV: the
/// table shifts hue additively and scales saturation and value, so each
/// step reads the shift at the current estimate and undoes it directly
/// (`h = h' − Δh`, `s = s' / ss`, `v = v' / vs`). That converges at the
/// rate the table varies across the lattice, not at its magnitude, so a
/// strong saturation boost (1.8× on a bundled GFX 50S table) converges as
/// fast as a gentle one, where an RGB-space fixed point stalls. A
/// saturation clipped at 1 has no unique pre-image; the smallest one is
/// returned, which the forward maps back to the clip, except for a lifted
/// (negative-channel) pixel, whose pre-image keeps saturation 1 so the
/// forward re-derives the same lift.
///
/// The forward lifts a negative channel by the INPUT's deficit, which a
/// desaturating table shrinks on the way out, so the HSV solve reads the
/// wrong lift there: a pixel with a negative channel, or whose pre-image
/// lands on the gamut boundary (saturation 1, where a negative pre-image
/// can map to a positive output), under a desaturating table then takes
/// [`NEGATIVE_REFINE_STEPS`] RGB fixed-point steps from that estimate. Under
/// a boosting table the output clipped instead, and the HSV answer stands.
pub fn invert_one_blended(
    y: [f32; 3],
    dims: [u32; 3],
    encoding: HsmEncoding,
    tables: (&[f32], &[f32]),
    t: f32,
    iterations: u32,
) -> [f32; 3] {
    let deficit = |p: [f32; 3]| (-p[0].min(p[1]).min(p[2])).max(0.0);
    let lift = deficit(y);
    let lifted = [y[0] + lift, y[1] + lift, y[2] + lift];
    let encoded = if matches!(encoding, HsmEncoding::Srgb) {
        lifted.map(linear_to_srgb_one)
    } else {
        lifted
    };
    let (h2, s2, v2) = rgb_to_hsv(encoded);
    let (h, s, v, ss) = (0..iterations).fold((h2, s2, v2, 1.0), |(h, s, v, _), _| {
        let (hd, ss, vs) = lookup_blended(dims, tables, t, h, s, v);
        let w_chroma = (s / 0.01).clamp(0.0, 1.0);
        let ss = 1.0 + (ss - 1.0) * w_chroma;
        let vs = 1.0 + (vs - 1.0) * w_chroma;
        (
            (h2 - hd * w_chroma).rem_euclid(360.0),
            if lift > 0.0 {
                1.0
            } else {
                (s2 / ss.max(1e-6)).clamp(0.0, 1.0)
            },
            v2 / vs.max(1e-6),
            ss,
        )
    });
    let rgb = hsv_to_rgb(h, s, v);
    let decoded = if matches!(encoding, HsmEncoding::Srgb) {
        rgb.map(srgb_to_linear_one)
    } else {
        rgb
    };
    let x = [decoded[0] - lift, decoded[1] - lift, decoded[2] - lift];
    let shrinks_a_boundary_pre_image = (lift > 0.0 || s >= 1.0) && ss < 1.0;
    if !shrinks_a_boundary_pre_image {
        return x;
    }
    (0..NEGATIVE_REFINE_STEPS).fold(x, |x, _| {
        let back = apply_one_blended(x, dims, encoding, tables, t);
        [
            x[0] + y[0] - back[0],
            x[1] + y[1] - back[1],
            x[2] + y[2] - back[2],
        ]
    })
}

/// RGB fixed-point steps after the HSV solve for a pixel with a negative
/// channel (see [`invert_one_blended`]).
pub const NEGATIVE_REFINE_STEPS: u32 = 3;

/// The interpolated (hueDelta, satScale, valScale) of the `t`-blend of two
/// same-shape tables at `(hue, sat, val)`. See [`apply_one_blended`].
#[inline]
fn lookup_blended(
    dims: [u32; 3],
    tables: (&[f32], &[f32]),
    t: f32,
    hue: f32,
    sat: f32,
    val: f32,
) -> (f32, f32, f32) {
    let t = t.clamp(0.0, 1.0);
    lookup_with(dims, hue, sat, val, |h, s, v| {
        let a = entry(dims, tables.0, h, s, v);
        let b = entry(dims, tables.1, h, s, v);
        let blended = a[0] + t * shorter_arc(b[0] - a[0]);
        let above = if blended > 360.0 {
            blended - 360.0
        } else {
            blended
        };
        let hue = if above < -360.0 { above + 360.0 } else { above };
        [
            hue,
            (1.0 - t) * a[1] + t * b[1],
            (1.0 - t) * a[2] + t * b[2],
        ]
    })
}

#[inline]
fn shorter_arc(diff: f32) -> f32 {
    if diff > 180.0 {
        diff - 360.0
    } else if diff < -180.0 {
        diff + 360.0
    } else {
        diff
    }
}
