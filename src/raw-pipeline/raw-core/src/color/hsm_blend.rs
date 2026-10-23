//! The reciprocal-CCT blend of two same-shape HueSatMaps, evaluated without
//! materialising the blended table, and its inverse — what the live
//! white-balance drag runs per pixel (#5099, `stages::wb_camera`).

#[cfg(doc)]
use super::{apply_one, lerp_tables, HsmTable};
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
/// fast as a gentle one, where an RGB-space fixed point stalls.
///
/// A pre-image on the gamut boundary (saturation 1, which is where every
/// input with a negative channel lands after the forward's lift) needs its
/// lift solved too, because the forward lifts by the INPUT's deficit:
/// - under a boosting table the output saturation clipped at 1 and kept the
///   input's lift, so the output's own deficit is the lift;
/// - under a desaturating table the output saturation is exactly the
///   table's scale, so the lift is the one that gives the lifted output that
///   saturation ([`lift_for_saturation`]).
pub fn invert_one_blended(
    y: [f32; 3],
    dims: [u32; 3],
    encoding: HsmEncoding,
    tables: (&[f32], &[f32]),
    t: f32,
    iterations: u32,
) -> [f32; 3] {
    let lifted_out = deficit(y);
    let (h0, s0, v0) = target(y, lifted_out, encoding);
    let (h, s, v, lift) = (0..iterations).fold((h0, s0, v0, lifted_out), |(h, s, v, _), _| {
        let (hd, ss, vs) = lookup_blended(dims, tables, t, h, s, v);
        let w_chroma = (s / 0.01).clamp(0.0, 1.0);
        let ss = 1.0 + (ss - 1.0) * w_chroma;
        let vs = 1.0 + (vs - 1.0) * w_chroma;
        let on_boundary = lifted_out > 0.0 || s >= 1.0;
        let lift = if on_boundary && ss < 1.0 {
            lift_for_saturation(y, ss, encoding)
        } else {
            lifted_out
        };
        let (h2, s2, v2) = target(y, lift, encoding);
        let s_next = if lift > 0.0 {
            1.0
        } else {
            (s2 / ss.max(1e-6)).clamp(0.0, 1.0)
        };
        (
            (h2 - hd * w_chroma).rem_euclid(360.0),
            s_next,
            v2 / vs.max(1e-6),
            lift,
        )
    });
    let rgb = hsv_to_rgb(h, s, v);
    let decoded = if matches!(encoding, HsmEncoding::Srgb) {
        rgb.map(srgb_to_linear_one)
    } else {
        rgb
    };
    [decoded[0] - lift, decoded[1] - lift, decoded[2] - lift]
}

fn deficit(p: [f32; 3]) -> f32 {
    (-p[0].min(p[1]).min(p[2])).max(0.0)
}

/// HSV of `y` lifted by `lift`, in the table's encoding.
fn target(y: [f32; 3], lift: f32, encoding: HsmEncoding) -> (f32, f32, f32) {
    let lifted = [y[0] + lift, y[1] + lift, y[2] + lift];
    rgb_to_hsv(if matches!(encoding, HsmEncoding::Srgb) {
        lifted.map(linear_to_srgb_one)
    } else {
        lifted
    })
}

/// Bisection steps of [`lift_for_saturation`] on an sRGB-encoded table,
/// where the lift has no closed form: 24 halvings of a bracket at most a few
/// units wide land well under one 16-bit step.
pub const LIFT_BISECTION_STEPS: u32 = 24;

/// The lift `L ≥ deficit(y)` at which `y + L` has saturation `target_s`.
/// Saturation falls as a uniform lift grows, so the root is unique; a
/// linear table has it in closed form (`(max − min) / s − max`), an sRGB one
/// is bisected.
fn lift_for_saturation(y: [f32; 3], target_s: f32, encoding: HsmEncoding) -> f32 {
    let floor = deficit(y);
    let (_, s_floor, _) = target(y, floor, encoding);
    if s_floor <= target_s || target_s <= 0.0 {
        return floor;
    }
    let (lo, hi) = (y[0].min(y[1]).min(y[2]), y[0].max(y[1]).max(y[2]));
    if matches!(encoding, HsmEncoding::Linear) {
        return ((hi - lo) / target_s - hi).max(floor);
    }
    let span = (hi - lo).max(1e-6);
    let upper = (0..32)
        .map(|k| floor + span * (1u32 << k.min(30)) as f32)
        .find(|l| target(y, *l, encoding).1 <= target_s)
        .unwrap_or(floor + span * 1e9);
    let (a, b) = (0..LIFT_BISECTION_STEPS).fold((floor, upper), |(a, b), _| {
        let mid = 0.5 * (a + b);
        if target(y, mid, encoding).1 > target_s {
            (mid, b)
        } else {
            (a, mid)
        }
    });
    0.5 * (a + b)
}

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
