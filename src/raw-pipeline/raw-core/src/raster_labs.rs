//! libvips' own 8-bit sRGB ↔ LABS colour chain (#3504 PR-E fix wave 2), the
//! space `vips_sharpen` works in.
//!
//! `sharpen({sigma})` is the only filter that leaves RGB, and its accuracy
//! is therefore bounded by how exactly this round trip matches libvips'.
//! Maple's own textbook sRGB↔CIELAB conversion was close — within about
//! 0.01 `L*` — but it was **not** an identity: a byte that went in came
//! back one code different often enough to matter, and on a premultiplied
//! image the unpremultiply then multiplied that one code by `255/alpha`.
//! Measured before this file existed: max diff versus sharp 0.34.5 of 1 at
//! alpha 255, 2 at 128, 4 at 64, 16 at 16 and **85** at alpha 3.
//!
//! So the chain here is libvips', stage for stage, in `f32` where libvips
//! uses `float`:
//!
//! 1. **sRGB → scRGB** (`vips_sRGB2scRGB`): a 256-entry lookup of the sRGB
//!    EOTF, built by `calcul_tables` in `colour/LabQ2sRGB.c`.
//! 2. **scRGB → XYZ** (`vips_scRGB2XYZ`): scale by D65's `Y0` (100), then
//!    libvips' own 4-decimal matrix — not the 7-decimal IEC 61966-2-1 one.
//! 3. **XYZ → Lab** (`vips_XYZ2Lab`): a 100 000-entry cube-root table with
//!    linear interpolation between neighbours, and libvips' D65 white
//!    (`95.0470, 100.0, 108.8827`).
//! 4. **Lab → LabS** (`vips_Lab2LabS`): `L·(32767/100)`, `a`/`b`·(32768/128),
//!    each clipped and then **truncated** into a signed 16-bit integer.
//!
//! And back out again through `LabS2Lab`, `Lab2XYZ`, `XYZ2scRGB` and
//! `scRGB2sRGB` — the last of which interpolates a 257-entry inverse lookup
//! and `rint`s the result.
//!
//! With all of that in place the round trip is an **exact identity**:
//! verified byte-for-byte over a 13 000-colour sweep of the sRGB cube, and
//! the forward `L*` matches libvips' own `toColourspace('lab')` output to
//! 2e-5 `L*` units. The residual that remains is the truncation in step 4
//! landing on the other side of an integer boundary for roughly one colour
//! in a thousand, where a single `f32` unit in the last place is enough to
//! change the answer.

use std::sync::OnceLock;

/// libvips' D65 white point (`VIPS_D65_X0`/`Y0`/`Z0`, `colour.h`). Note
/// `Z0` is 108.8827, not the 108.883 or 108.88 other references use — the
/// chain is sensitive enough that the extra digits matter.
const X0: f64 = 95.0470;
const Y0: f64 = 100.0;
const Z0: f64 = 108.8827;

/// `vips_XYZ2Lab`'s cube-root table resolution.
const QUANT: usize = 100_000;

/// `L*` units per LabS count: LabS packs `L*` 0..100 into 0..32767.
pub(crate) const LABS_PER_L: f64 = 32767.0 / 100.0;

struct Tables {
    /// `vips_v2Y_8`: sRGB byte → linear light.
    v2y: [f32; 256],
    /// `vips_Y2v_8`: linear light → sRGB byte, 257 entries because
    /// `vips_col_scRGB2sRGB` interpolates against `lut[i + 1]`.
    y2v: [i32; 257],
    /// `vips_XYZ2Lab`'s `cbrt_table`.
    cbrt: Vec<f32>,
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut v2y = [0f32; 256];
        let mut y2v = [0i32; 257];
        for i in 0..256 {
            let f = i as f32 / 255.0;
            v2y[i] = if f <= 0.04045 {
                f / 12.92
            } else {
                ((f + 0.055) / 1.055).powf(2.4)
            };
            let v = if f <= 0.0031308 {
                12.92 * f
            } else {
                1.055 * f.powf(1.0 / 2.4) - 0.055
            };
            y2v[i] = (255.0 * v).round_ties_even() as i32;
        }
        y2v[256] = y2v[255];
        let cbrt = (0..QUANT)
            .map(|i| {
                // `XYZ2Lab.c:97`: `float Y = (double) i / QUANT_ELEMENTS`
                // narrows to `float` on assignment, and the dark-branch
                // multiply that follows (`XYZ2Lab.c:100`, `7.787F * Y`) is
                // done in `float`, not `double`. Narrowing after the
                // multiply instead of before it disagrees on 71 of this
                // table's 100,000 entries.
                let y = (i as f64 / QUANT as f64) as f32;
                if (y as f64) < 0.008856 {
                    7.787_f32 * y + (16.0f32 / 116.0)
                } else {
                    y.cbrt()
                }
            })
            .collect();
        Tables { v2y, y2v, cbrt }
    })
}

/// `vips_XYZ2Lab`'s interpolated cube root: index the table with the
/// integer part, interpolate linearly toward the next entry.
fn cbrt_lookup(n: f32) -> f32 {
    let cbrt = &tables().cbrt;
    let i = (n as i32).clamp(0, QUANT as i32 - 2) as usize;
    let f = n - i as f32;
    cbrt[i] + f * (cbrt[i + 1] - cbrt[i])
}

/// `vips_colourspace(sRGB → LABS)` for one 8-bit pixel, as
/// `[L, a, b]` signed 16-bit counts.
pub(crate) fn srgb_to_labs(rgb: [u8; 3]) -> [i32; 3] {
    let t = tables();
    // sRGB → scRGB → XYZ. The `* Y0` and the matrix are one stage in
    // libvips (`vips_scRGB2XYZ_line` inlines `vips_col_scRGB2XYZ`).
    let r = (t.v2y[rgb[0] as usize] as f64 * Y0) as f32;
    let g = (t.v2y[rgb[1] as usize] as f64 * Y0) as f32;
    let b = (t.v2y[rgb[2] as usize] as f64 * Y0) as f32;
    let x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    // XYZ → Lab. libvips divides the scaled value by a `double` white
    // point, so the division is the one place that is not `f32`.
    let cbx = cbrt_lookup(((QUANT as f32 * x) as f64 / X0) as f32);
    let cby = cbrt_lookup(((QUANT as f32 * y) as f64 / Y0) as f32);
    let cbz = cbrt_lookup(((QUANT as f32 * z) as f64 / Z0) as f32);
    let l = 116.0 * cby - 16.0;
    let a = 500.0 * (cbx - cby);
    let bb = 200.0 * (cby - cbz);
    // Lab → LabS: clip, then truncate into a signed short. `Lab2LabS.c:66`
    // multiplies libvips' `float` Lab sample by an untyped (double) literal
    // constant — `p[0] * (32767.0 / 100.0)` promotes to `double` — so the
    // scale itself has to happen in `f64`, not `f32`, before truncating.
    [
        ((l as f64 * (32767.0 / 100.0)) as i32).clamp(0, 32767),
        ((a as f64 * (32768.0 / 128.0)) as i32).clamp(-32768, 32767),
        ((bb as f64 * (32768.0 / 128.0)) as i32).clamp(-32768, 32767),
    ]
}

/// `vips_colourspace(LABS → sRGB)` for one pixel — the inverse of
/// [`srgb_to_labs`], and an exact one for every byte triple.
pub(crate) fn labs_to_srgb(labs: [i32; 3]) -> [u8; 3] {
    // `LabS2Lab.c:62`: `q[0] = p[0] / (32767.0 / 100.0)` divides the
    // `signed short` sample by that same double literal constant in
    // `double`, then narrows to the output's `float` on assignment — so
    // the division has to happen in `f64` before the value becomes `f32`.
    let l = (labs[0] as f64 / (32767.0 / 100.0)) as f32;
    let a = (labs[1] as f64 / (32768.0 / 128.0)) as f32;
    let b = (labs[2] as f64 / (32768.0 / 128.0)) as f32;
    // Lab → XYZ. `vips_col_Lab2XYZ_helper` keeps `cby` and `tmp` in
    // `double` and stores each of X/Y/Z back to an `f32`.
    let (y, cby) = if l < 8.0 {
        // libvips derives `cby` from the ALREADY f32-rounded Y, not from
        // the double it computed it with — so the rounding has to happen
        // here, before `cby`, to match.
        let y = ((l as f64 * Y0) / 903.3) as f32;
        (y, 7.787 * (y as f64 / Y0) + 16.0 / 116.0)
    } else {
        let cby = (l as f64 + 16.0) / 116.0;
        ((Y0 * cby * cby * cby) as f32, cby)
    };
    let tmp = a as f64 / 500.0 + cby;
    let x = if tmp < 0.2069 {
        (X0 * (tmp - 0.13793) / 7.787) as f32
    } else {
        (X0 * tmp * tmp * tmp) as f32
    };
    let tmp = cby - b as f64 / 200.0;
    let z = if tmp < 0.2069 {
        (Z0 * (tmp - 0.13793) / 7.787) as f32
    } else {
        (Z0 * tmp * tmp * tmp) as f32
    };
    // XYZ → scRGB, with libvips' 6-decimal inverse matrix.
    let (x, y, z) = (
        (x as f64 / Y0) as f32,
        (y as f64 / Y0) as f32,
        (z as f64 / Y0) as f32,
    );
    let r = 3.240625 * x + -1.537208 * y + -0.498629 * z;
    let g = -0.968931 * x + 1.875756 * y + 0.041518 * z;
    let b = 0.055710 * x + -0.204021 * y + 1.056996 * z;
    [encode_srgb(r), encode_srgb(g), encode_srgb(b)]
}

/// `vips_colourspace(sRGB → B_W)` for one pixel — libvips'
/// `vips_col_scRGB2BW`, which is what sharp's `greyscale()` and
/// `threshold({greyscale: true})` really run.
///
/// It is the Rec.709 luminance of the *linear* channels, taken straight
/// from the same `v2Y` lookup the Lab chain uses and re-encoded through the
/// same `Y2v` one — not a weighted sum of the gamma-encoded bytes, which
/// would give 54 for pure red instead of the 127 sharp writes. Computing it
/// this way rather than with an sRGB transfer function of our own closes the
/// last +/-1 disagreement with libvips (#3572), which mattered out of all
/// proportion through `threshold`: a luma one code either side of the
/// threshold flips a whole sample between 0 and 255.
pub(crate) fn srgb_to_bw(rgb: [u8; 3]) -> u8 {
    let t = tables();
    let y = 0.2126 * t.v2y[rgb[0] as usize]
        + 0.7152 * t.v2y[rgb[1] as usize]
        + 0.0722 * t.v2y[rgb[2] as usize];
    encode_srgb(y)
}

/// `vips_col_scRGB2sRGB`: clip into range, then interpolate the inverse
/// lookup and round to nearest. A `NaN` channel becomes 0, as it does
/// there.
fn encode_srgb(v: f32) -> u8 {
    if v.is_nan() {
        return 0;
    }
    let t = tables();
    let scaled = (v * 255.0).clamp(0.0, 255.0);
    let i = scaled as usize;
    let f = scaled - i as f32;
    let out = t.y2v[i] as f32 + (t.y2v[i + 1] - t.y2v[i]) as f32 * f;
    out.round_ties_even().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
#[path = "raster_labs_tests.rs"]
mod tests;
