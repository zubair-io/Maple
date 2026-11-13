//! The reciprocal-CCT blend of two same-shape HueSatMaps, evaluated without
//! materialising the blended table.

#[cfg(doc)]
use super::{apply_one, lerp_tables, HsmTable};
use super::{apply_one_with, entry, lookup_with, HsmEncoding};

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

#[cfg(test)]
#[path = "hsm_blend_tests.rs"]
mod tests;
