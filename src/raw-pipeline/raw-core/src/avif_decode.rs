//! AVIF decoding: ISO-BMFF container via `avif-parse`, AV1 payload via `rav1d`
//! (a pure-Rust port of dav1d, built without asm so the publish build stays
//! free of C toolchains). Behind the `avif` cargo feature like `avif.rs`.

use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::{Dav1dContext, Dav1dSettings};
use rav1d::include::dav1d::headers::Dav1dSequenceHeader;
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::{
    dav1d_close, dav1d_data_create, dav1d_data_unref, dav1d_default_settings, dav1d_get_picture,
    dav1d_open, dav1d_parse_sequence_header, dav1d_picture_unref, dav1d_send_data,
};
use std::io::Cursor;
use std::mem::MaybeUninit;
use std::ptr::NonNull;

use crate::error::{Error, Result};
use crate::raster::RasterImage;

// dav1d encodes "try again" as `-(libc::EAGAIN as c_int)`. That errno is
// platform-specific (11 on Linux, 35 on macOS); rav1d's own `error` module
// that defines the mapping is crate-private, so it's recomputed here from
// the same `libc` crate rather than hard-coded for one OS.
const EAGAIN: i32 = -(libc::EAGAIN as i32);

/// Container-level facts, read without decoding any pixel data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AvifProbe {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub bit_depth: u8,
}

/// `ftyp` box with an AVIF-family brand in the first 32 bytes.
pub fn is_avif(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && bytes[8..bytes.len().min(32)]
            .windows(4)
            .any(|w| w == b"avif" || w == b"avis" || w == b"mif1")
}

fn err(reason: impl Into<String>) -> Error {
    Error::Decode {
        path: "<memory>".into(),
        reason: reason.into(),
    }
}

fn parse_container(bytes: &[u8]) -> Result<avif_parse::AvifData> {
    avif_parse::read_avif(&mut Cursor::new(bytes)).map_err(|e| err(format!("avif container: {e}")))
}

pub fn probe_avif(bytes: &[u8]) -> Result<AvifProbe> {
    let data = parse_container(bytes)?;
    let obu: &[u8] = &data.primary_item;
    let mut hdr = MaybeUninit::<Dav1dSequenceHeader>::zeroed();
    // SAFETY: `hdr` is a valid, writable location; `obu` outlives the call.
    let rc = unsafe {
        dav1d_parse_sequence_header(
            NonNull::new(hdr.as_mut_ptr()),
            NonNull::new(obu.as_ptr() as *mut u8),
            obu.len(),
        )
    };
    if rc.0 != 0 {
        return Err(err(format!(
            "avif sequence header parse failed (dav1d rc {})",
            rc.0
        )));
    }
    // SAFETY: rc == 0 means dav1d fully initialised the header.
    let hdr = unsafe { hdr.assume_init() };
    Ok(AvifProbe {
        width: hdr.max_width as u32,
        height: hdr.max_height as u32,
        has_alpha: data.alpha_item.is_some(),
        bit_depth: if hdr.hbd == 0 {
            8
        } else if hdr.hbd == 1 {
            10
        } else {
            12
        },
    })
}

/// One decoded AV1 frame with planes copied out to 8-bit.
struct Yuv {
    width: usize,
    height: usize,
    /// 0 = I400, 1 = I420, 2 = I422, 3 = I444 (dav1d layout numbering).
    layout: u32,
    /// 0 = limited (studio) range, 1 = full range.
    full_range: bool,
    /// AV1 matrix_coefficients: 0 identity, 1 BT.709, 5/6 BT.601, 9 BT.2020 NCL, 2 unspecified.
    matrix: u32,
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
}

fn copy_plane(base: *const u8, stride: isize, w: usize, h: usize, bpc: i32) -> Vec<u8> {
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

/// Closes the dav1d decoding context when dropped — on the normal return
/// below, on an early `?` return, or on a panic unwinding through
/// `decode_obu`. A plain `unsafe { ... dav1d_close(...) }` at the end of a
/// function is *not* run on those last two paths, which is what let the
/// context leak whenever a step in between returned an error.
struct DecodeContext(Option<Dav1dContext>);

impl DecodeContext {
    fn open(settings: &mut Dav1dSettings) -> Result<Self> {
        let mut ctx: Option<Dav1dContext> = None;
        // SAFETY: `ctx` and `settings` are valid, live locals for the call.
        let rc = unsafe { dav1d_open(NonNull::new(&mut ctx), NonNull::new(settings)) };
        if rc.0 != 0 {
            return Err(err(format!("dav1d_open failed ({})", rc.0)));
        }
        Ok(Self(ctx))
    }
}

impl Drop for DecodeContext {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a context from `dav1d_open` (this type is only
        // ever constructed after `dav1d_open` succeeds) that has not yet
        // been passed to `dav1d_close`.
        unsafe { dav1d_close(NonNull::new(&mut self.0)) };
    }
}

/// Releases dav1d's reference on an input buffer when dropped, on every
/// exit path from `decode_obu`. `dav1d_data_unref` on an already-unreffed
/// (zeroed) buffer is a no-op, so this is safe even after `rav1d_send_data`
/// fully consumed the buffer itself (which zeroes it in place).
struct DataGuard(Dav1dData);

impl Drop for DataGuard {
    fn drop(&mut self) {
        // SAFETY: `self.0` was fully initialised by `dav1d_data_create`.
        unsafe { dav1d_data_unref(NonNull::new(&mut self.0)) };
    }
}

/// Releases dav1d's reference on a decoded picture when dropped, on every
/// exit path from `decode_obu` — including the "picture has a missing
/// plane" error below, which previously `unwrap()`-panicked past the
/// cleanup entirely.
struct PictureGuard(Dav1dPicture);

impl Drop for PictureGuard {
    fn drop(&mut self) {
        // SAFETY: `self.0` was fully initialised by a successful `dav1d_get_picture`
        // (this type is only ever constructed from one).
        unsafe { dav1d_picture_unref(NonNull::new(&mut self.0)) };
    }
}

fn decode_obu(obu: &[u8]) -> Result<Yuv> {
    let mut settings = MaybeUninit::<Dav1dSettings>::uninit();
    // SAFETY: `settings` is a valid, writable location.
    unsafe { dav1d_default_settings(NonNull::new(settings.as_mut_ptr()).unwrap()) };
    // SAFETY: `dav1d_default_settings` unconditionally initialises `settings`.
    let mut settings = unsafe { settings.assume_init() };
    settings.n_threads = 1;

    // `ctx` closes on every exit below (`?`, panic, or the `Ok` at the end).
    let ctx = DecodeContext::open(&mut settings)?;

    let mut data = MaybeUninit::<Dav1dData>::zeroed();
    // SAFETY: `data` is a valid, writable location.
    let dst = unsafe { dav1d_data_create(NonNull::new(data.as_mut_ptr()), obu.len()) };
    if dst.is_null() {
        return Err(err("dav1d_data_create returned null"));
    }
    // SAFETY: `dst` is a dav1d-allocated buffer of `obu.len()` bytes (the
    // null case, the only way it could be smaller or absent, returned above);
    // `obu` has `obu.len()` bytes to copy from.
    unsafe { std::ptr::copy_nonoverlapping(obu.as_ptr(), dst, obu.len()) };
    // SAFETY: `dav1d_data_create` fully wrote `data` before returning non-null.
    // Wrapped in `DataGuard` so every exit from here on releases the ref.
    let mut data = DataGuard(unsafe { data.assume_init() });

    let mut pic = MaybeUninit::<Dav1dPicture>::zeroed();
    // SAFETY: `ctx.0` is an open context; `data.0` and `pic` are valid locals.
    let mut rc = unsafe { dav1d_send_data(ctx.0, NonNull::new(&mut data.0)) };
    if rc.0 != 0 && rc.0 != EAGAIN {
        return Err(err(format!("dav1d_send_data failed ({})", rc.0)));
    }
    // SAFETY: same as above.
    rc = unsafe { dav1d_get_picture(ctx.0, NonNull::new(pic.as_mut_ptr())) };
    let mut attempts = 0;
    while rc.0 == EAGAIN && attempts < 16 {
        if data.0.sz > 0 {
            // SAFETY: same as above.
            let _ = unsafe { dav1d_send_data(ctx.0, NonNull::new(&mut data.0)) };
        }
        // SAFETY: same as above.
        rc = unsafe { dav1d_get_picture(ctx.0, NonNull::new(pic.as_mut_ptr())) };
        attempts += 1;
    }
    if rc.0 != 0 {
        return Err(err(format!("dav1d_get_picture failed ({})", rc.0)));
    }
    // Input is fully consumed (or intentionally abandoned on `EAGAIN`
    // exhaustion) either way — release dav1d's ref before touching output.
    drop(data);

    // SAFETY: `rc.0 == 0` means dav1d fully populated `pic`.
    // Wrapped in `PictureGuard` so every exit from here on releases the ref.
    let pic = PictureGuard(unsafe { pic.assume_init() });
    let (w, h) = (pic.0.p.w as usize, pic.0.p.h as usize);
    let layout = pic.0.p.layout;
    let bpc = pic.0.p.bpc;
    let (ssx, ssy) = match layout {
        1 => (1, 1),
        2 => (1, 0),
        _ => (0, 0),
    };
    let (cw, ch) = ((w + ssx) >> ssx, (h + ssy) >> ssy);
    let y_plane =
        pic.0.data[0].ok_or_else(|| err("dav1d returned a picture with a missing luma plane"))?;
    let y = copy_plane(y_plane.as_ptr() as *const u8, pic.0.stride[0], w, h, bpc);
    let (u, v) = if layout == 0 {
        (Vec::new(), Vec::new())
    } else {
        let u_plane = pic.0.data[1]
            .ok_or_else(|| err("dav1d returned a picture with a missing chroma plane"))?;
        let v_plane = pic.0.data[2]
            .ok_or_else(|| err("dav1d returned a picture with a missing chroma plane"))?;
        (
            copy_plane(u_plane.as_ptr() as *const u8, pic.0.stride[1], cw, ch, bpc),
            copy_plane(v_plane.as_ptr() as *const u8, pic.0.stride[1], cw, ch, bpc),
        )
    };
    // SAFETY: dav1d keeps `seq_hdr` alive for as long as `pic` is (`pic` is
    // still alive here — its `PictureGuard` hasn't dropped yet).
    let seq = pic.0.seq_hdr.map(|p| unsafe { p.as_ref() });
    let (full_range, matrix) = seq
        .map(|s| (s.color_range != 0, s.mtrx as u32))
        .unwrap_or((false, 2));

    Ok(Yuv {
        width: w,
        height: h,
        layout,
        full_range,
        matrix,
        y,
        u,
        v,
    })
    // `pic` drops here (unrefs the picture), then `ctx` drops (closes the
    // context) — reverse declaration order, matching the original explicit
    // unref-then-close sequence.
}

fn clamp8(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

/// Expands a limited/studio-range 8-bit sample (16-235, AV1's `color_range =
/// 0`) to full range (0-255); a full-range sample passes through unchanged.
/// Used for both monochrome luma and alpha-item samples, which dav1d reports
/// coded range for identically via `Dav1dSequenceHeader::color_range`.
fn expand_range(sample: u8, full_range: bool) -> u8 {
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

fn yuv_to_rgb(yuv: &Yuv) -> Vec<u8> {
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

/// Decode an AVIF still image to RGB8 (or RGBA8 when the container carries an
/// alpha item). 10/12-bit sources are down-converted to 8-bit; chroma is
/// upsampled by sample replication (the consumers are thumbnails/previews).
pub fn decode_avif(bytes: &[u8]) -> Result<RasterImage> {
    let data = parse_container(bytes)?;
    let colour = decode_obu(&data.primary_item)?;
    let rgb = yuv_to_rgb(&colour);
    let (w, h) = (colour.width as u32, colour.height as u32);
    let Some(alpha_obu) = data.alpha_item.as_deref() else {
        return Ok(RasterImage::new_rgb(w, h, rgb));
    };
    let alpha = decode_obu(alpha_obu)?;
    if alpha.width != colour.width || alpha.height != colour.height {
        return Err(err(
            "avif alpha item dimensions differ from the colour item",
        ));
    }
    // The alpha item is itself a coded monochrome AV1 image, so a
    // limited-range encode (`color_range = 0`) needs the same 16-235 → 0-255
    // expansion as luma before the sample is a usable opacity value.
    let premultiplied = data.premultiplied_alpha;
    let rgba = rgb
        .chunks_exact(3)
        .zip(&alpha.y)
        .flat_map(|(px, &raw_a)| {
            let a = expand_range(raw_a, alpha.full_range);
            if premultiplied && a > 0 {
                // MIAF `prem`: stored RGB is `straight * alpha / 255`, so
                // recover the straight (un-premultiplied) value here — a
                // dark, alpha-scaled RGB triple is not what a semi-
                // transparent pixel should render as.
                let unmultiply =
                    |c: u8| (((c as u32 * 255) + (a as u32 / 2)) / a as u32).min(255) as u8;
                [unmultiply(px[0]), unmultiply(px[1]), unmultiply(px[2]), a]
            } else {
                [px[0], px[1], px[2], a]
            }
        })
        .collect();
    Ok(RasterImage::new_rgba(w, h, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient_rgb(w: u32, h: u32) -> Vec<u8> {
        (0..h)
            .flat_map(|y| {
                (0..w).flat_map(move |x| {
                    let r = (x * 255 / (w - 1)) as u8;
                    let g = (y * 255 / (h - 1)) as u8;
                    [r, g, 128u8]
                })
            })
            .collect()
    }

    fn mean_abs_error(a: &[u8], b: &[u8]) -> f64 {
        assert_eq!(a.len(), b.len());
        a.iter()
            .zip(b)
            .map(|(x, y)| (*x as f64 - *y as f64).abs())
            .sum::<f64>()
            / a.len() as f64
    }

    #[test]
    fn round_trips_an_rgb_avif_within_tolerance() {
        let (w, h) = (64, 48);
        let rgb = gradient_rgb(w, h);
        let bytes = crate::avif::encode(w, h, &rgb, 80).unwrap();
        assert!(is_avif(&bytes));
        let decoded = decode_avif(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height, decoded.channels), (w, h, 3));
        let mae = mean_abs_error(&decoded.data, &rgb);
        assert!(mae < 3.0, "mean abs error {mae} too high for q80 AVIF");
    }

    #[test]
    fn decodes_the_alpha_item_into_rgba() {
        use image::{codecs::avif::AvifEncoder, ExtendedColorType, ImageEncoder};
        let (w, h) = (16u32, 8u32);
        let rgba: Vec<u8> = (0..(w * h))
            .flat_map(|i| [200u8, 100, 50, if i % 2 == 0 { 255 } else { 0 }])
            .collect();
        let mut out = Vec::new();
        AvifEncoder::new_with_speed_quality(&mut out, 8, 90)
            .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
            .unwrap();
        let decoded = decode_avif(&out).unwrap();
        assert_eq!(decoded.channels, 4);
        assert_eq!(decoded.data.len(), (w * h * 4) as usize);
        // Alpha is coded losslessly enough at q90 to keep the checkerboard.
        assert!(decoded.data[3] > 200 && decoded.data[7] < 60);
    }

    #[test]
    fn probe_reads_dimensions_without_decoding_pixels() {
        let rgb = gradient_rgb(40, 30);
        let bytes = crate::avif::encode(40, 30, &rgb, 60).unwrap();
        let probe = probe_avif(&bytes).unwrap();
        assert_eq!(
            (probe.width, probe.height, probe.has_alpha, probe.bit_depth),
            (40, 30, false, 8)
        );
    }

    #[test]
    fn rejects_non_avif_bytes() {
        assert!(!is_avif(b"\x89PNG\r\n\x1a\n"));
        assert!(decode_avif(b"not an avif at all").is_err());
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
