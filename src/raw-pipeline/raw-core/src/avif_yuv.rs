//! AVIF pixel plumbing: dav1d's planar output copied out to 8-bit, then
//! converted to interleaved RGB. Split out of `avif_decode.rs`, which keeps
//! the container walk and the rav1d calls; nothing here touches rav1d or
//! `avif-parse`, so none of it can panic on a corrupt stream.

/// One decoded AV1 frame with planes copied out to 8-bit.
pub(crate) struct Yuv {
    pub(crate) width: usize,
    pub(crate) height: usize,
    /// 0 = I400, 1 = I420, 2 = I422, 3 = I444 (dav1d layout numbering).
    pub(crate) layout: u32,
    /// 0 = limited (studio) range, 1 = full range.
    pub(crate) full_range: bool,
    /// AV1 matrix_coefficients: 0 identity, 1 BT.709, 5/6 BT.601, 9 BT.2020 NCL, 2 unspecified.
    pub(crate) matrix: u32,
    pub(crate) y: Vec<u8>,
    pub(crate) u: Vec<u8>,
    pub(crate) v: Vec<u8>,
}

pub(crate) fn copy_plane(base: *const u8, stride: isize, w: usize, h: usize, bpc: i32) -> Vec<u8> {
    let mut out = Vec::with_capacity(w * h);
    let shift = (bpc - 8).max(0) as u32;
    for row in 0..h {
        // SAFETY: dav1d guarantees `h` rows of at least `w` samples at `stride` spacing.
        let row_ptr = unsafe { base.offset(row as isize * stride) };
        if bpc == 8 {
            out.extend_from_slice(unsafe { std::slice::from_raw_parts(row_ptr, w) });
        } else {
            let samples = unsafe { std::slice::from_raw_parts(row_ptr as *const u16, w) };
            out.extend(samples.iter().map(|&s| (s >> shift) as u8));
        }
    }
    out
}

fn clamp8(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

/// Expands a limited/studio-range 8-bit sample (16-235, AV1's `color_range =
/// 0`) to full range (0-255); a full-range sample passes through unchanged.
/// Used for both monochrome luma and alpha-item samples, which dav1d reports
/// coded range for identically via `Dav1dSequenceHeader::color_range`.
pub(crate) fn expand_range(sample: u8, full_range: bool) -> u8 {
    if full_range {
        sample
    } else {
        clamp8((sample as f32 - 16.0) * 255.0 / 219.0)
    }
}

/// BT.601/709/2020 constant-luminance-free conversion (Kr, Kb pairs).
fn kr_kb(matrix: u32) -> (f32, f32) {
    match matrix {
        1 => (0.2126, 0.0722),
        9 => (0.2627, 0.0593),
        _ => (0.299, 0.114), // 5, 6 (BT.601) and 2 (unspecified) — libavif's default
    }
}

pub(crate) fn yuv_to_rgb(yuv: &Yuv) -> Vec<u8> {
    let (w, h) = (yuv.width, yuv.height);
    let mut rgb = Vec::with_capacity(w * h * 3);
    if yuv.layout == 0 {
        for &y in &yuv.y {
            let v = expand_range(y, yuv.full_range);
            rgb.extend_from_slice(&[v, v, v]);
        }
        return rgb;
    }
    let (ssx, ssy) = match yuv.layout {
        1 => (1, 1),
        2 => (1, 0),
        _ => (0, 0),
    };
    let cw = (w + ssx) >> ssx;
    if yuv.matrix == 0 {
        // Identity: planes are G, B, R.
        for row in 0..h {
            for col in 0..w {
                let i = row * w + col;
                let ci = (row >> ssy) * cw + (col >> ssx);
                rgb.extend_from_slice(&[yuv.v[ci], yuv.y[i], yuv.u[ci]]);
            }
        }
        return rgb;
    }
    let (kr, kb) = kr_kb(yuv.matrix);
    let kg = 1.0 - kr - kb;
    let (y_scale, y_off, c_scale) = if yuv.full_range {
        (1.0, 0.0, 1.0)
    } else {
        (255.0 / 219.0, 16.0, 255.0 / 224.0)
    };
    for row in 0..h {
        for col in 0..w {
            let i = row * w + col;
            let ci = (row >> ssy) * cw + (col >> ssx);
            let yv = (yuv.y[i] as f32 - y_off) * y_scale;
            let cb = (yuv.u[ci] as f32 - 128.0) * c_scale;
            let cr = (yuv.v[ci] as f32 - 128.0) * c_scale;
            let r = yv + 2.0 * (1.0 - kr) * cr;
            let b = yv + 2.0 * (1.0 - kb) * cb;
            let g = (yv - kr * r - kb * b) / kg;
            rgb.extend_from_slice(&[clamp8(r), clamp8(g), clamp8(b)]);
        }
    }
    rgb
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_bit_samples_down_convert_to_eight_bit() {
        // `image` 0.25's `AvifEncoder` is the only AVIF encoder in this
        // build, and it converts every input colour type — `Rgb16` included
        // — to `Rgba8` before handing pixels to ravif, so nothing here can
        // emit a 10-bit AV1 bitstream to round-trip through `decode_avif`.
        // The 10/12-bit branch is covered directly instead, on a plane
        // shaped exactly like dav1d's high-bit-depth output: `u16` samples
        // addressed through a byte stride.
        let samples: Vec<u16> = vec![0, 512, 1023, 256, 64, 960];
        let stride = 3 * std::mem::size_of::<u16>() as isize;
        let out = copy_plane(samples.as_ptr() as *const u8, stride, 3, 2, 10);
        assert_eq!(out, vec![0, 128, 255, 64, 16, 240]);
    }

    #[test]
    fn limited_range_alpha_expands_to_full_range() {
        // The `image`-crate AVIF encoder always produces full-range alpha,
        // so this can't be exercised through an encoded fixture — test the
        // range-expansion helper directly instead, per its own contract.
        assert_eq!(expand_range(16, false), 0);
        assert_eq!(expand_range(235, false), 255);
        assert_eq!(expand_range(128, true), 128);
    }
}
