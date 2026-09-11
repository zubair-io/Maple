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
use std::any::Any;
use std::io::Cursor;
use std::mem::{ManuallyDrop, MaybeUninit};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::NonNull;

use crate::avif_yuv::{copy_plane, expand_range, yuv_to_rgb, Yuv};
use crate::error::{Error, Result};
use crate::raster::RasterImage;

// dav1d encodes "try again" as `-(libc::EAGAIN as c_int)`. That errno is
// platform-specific (11 on Linux, 35 on macOS); rav1d's own `error` module
// that defines the mapping is crate-private, so it's recomputed here from
// the same `libc` crate rather than hard-coded for one OS.
const EAGAIN: i32 = -(libc::EAGAIN as i32);

/// Ceiling on the pixel count of a single decoded AV1 frame (rav1d's
/// `frame_size_limit` is a pixel count, not a byte count). dav1d's own
/// default is 0 = unlimited, so without this a hostile AVIF that *declares*
/// 65535x65535 in its frame header makes the decoder allocate multi-GB
/// planes — and `copy_plane` then allocates as much again — before anything
/// notices. 268 MP is ~13x the largest sensor Maple decodes (100 MP) and
/// ~65x the biggest derivative it writes, so no real input comes near it,
/// while an absurd declaration fails as a clean `Err` instead of an OOM.
const AVIF_MAX_FRAME_PIXELS: u32 = 268_000_000;

/// Container-level facts, read without decoding any pixel data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AvifProbe {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub bit_depth: u8,
}

/// `ftyp` box with an AVIF-family brand in the first 32 bytes. Delegates to
/// `raster::is_avif`, the single source of truth also used by the
/// feature-off dispatch path in `raster.rs` so both builds agree on what
/// counts as AVIF.
pub fn is_avif(bytes: &[u8]) -> bool {
    crate::raster::is_avif(bytes)
}

fn err(reason: impl Into<String>) -> Error {
    Error::Decode {
        path: "<memory>".into(),
        reason: reason.into(),
    }
}

/// Reports a caught panic as an ordinary decode error.
///
/// Both halves of this decoder panic outright on some corrupt inputs: rav1d
/// unwraps a `None` deep in tile decoding (#3517), and `avif-parse` trips a
/// parser-state assertion on a truncated box. A panic is not a usable failure
/// mode for the callers here — a thumbnail or preview path has to reject one
/// bad file, not take the process down with it — so every entry point below
/// runs its fallible work under `catch_unwind` and funnels the payload here.
/// The panic message is carried through when it is a plain string (which
/// covers `panic!`, `unwrap`, and `assert!`), because it is the only clue to
/// *where* the stream went bad.
fn panicked(what: &str, payload: Box<dyn Any + Send>) -> Error {
    match payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
    {
        Some(detail) => err(format!("{what}: {detail}")),
        None => err(what.to_owned()),
    }
}

fn parse_container(bytes: &[u8]) -> Result<avif_parse::AvifData> {
    catch_unwind(|| avif_parse::read_avif(&mut Cursor::new(bytes)))
        .map_err(|p| panicked("avif container parse panicked (corrupt stream)", p))?
        .map_err(|e| err(format!("avif container: {e}")))
}

/// Guards every rav1d call against an argument rav1d itself refuses.
///
/// rav1d validates its C-shim arguments with a macro whose failure path calls
/// `std::process::abort()` outright in a debug build (`validate_input!` →
/// `debug_abort`) — not a panic, so no barrier can contain it. The only
/// argument we derive from the file rather than control directly is the OBU
/// length, and `dav1d_send_data` / `dav1d_parse_sequence_header` both require
/// it to be non-zero. A corrupt container that parses but leaves the primary
/// (or alpha) item empty is therefore rejected here, before rav1d sees it.
fn non_empty_obu(obu: &[u8]) -> Result<&[u8]> {
    if obu.is_empty() {
        return Err(err("avif item carries no AV1 payload"));
    }
    Ok(obu)
}

/// `dav1d_parse_sequence_header` behind a panic barrier. Holds no rav1d
/// resource — the sequence header is written out by value — so unlike
/// `decode_obu_with_limit` there is nothing to leak when the call panics.
fn sequence_header(obu: &[u8]) -> Result<Dav1dSequenceHeader> {
    let obu = non_empty_obu(obu)?;
    catch_unwind(|| {
        let mut hdr = MaybeUninit::<Dav1dSequenceHeader>::zeroed();
        // SAFETY: `hdr` is a valid, writable location; `obu` outlives the call
        // and is non-empty, so the pointer is to a real `obu.len()`-byte slice.
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
        Ok(unsafe { hdr.assume_init() })
    })
    .map_err(|p| panicked("AVIF sequence-header parse panicked inside rav1d", p))?
}

pub fn probe_avif(bytes: &[u8]) -> Result<AvifProbe> {
    let data = parse_container(bytes)?;
    let hdr = sequence_header(&data.primary_item)?;
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

/// Every rav1d resource one decode acquires, in one owner.
///
/// Declaration order IS drop order in Rust, and these must be released in
/// reverse acquisition order: the picture's ref, then dav1d's ref on the input
/// buffer, then the context itself.
#[derive(Default)]
struct DecodeSlots {
    pic: Option<PictureGuard>,
    data: Option<DataGuard>,
    ctx: Option<DecodeContext>,
}

fn decode_obu(obu: &[u8]) -> Result<Yuv> {
    decode_obu_with_limit(obu, AVIF_MAX_FRAME_PIXELS)
}

/// `decode_obu` with the frame-size ceiling as a parameter, so the tests can
/// prove the limit is actually wired into the decoder by setting it below a
/// known-good image's pixel count.
///
/// The decode itself runs under `catch_unwind` because rav1d panics on some
/// corrupt streams (#3517) and, reached through its `extern "C-unwind"` shims,
/// that panic would otherwise escape into whatever called us.
///
/// The resources live in `slots` OUT HERE, not inside the closure, and they
/// are deliberately **not** released when the closure panics. Their
/// destructors call back into rav1d (`dav1d_picture_unref`, `dav1d_data_unref`,
/// `dav1d_close`), and doing that to a context rav1d just aborted a decode
/// halfway through risks a second panic — one raised *while already
/// unwinding*, which Rust turns into an unconditional `abort()`, the exact
/// process kill this barrier exists to prevent. So the panic path leaks the
/// context, input buffer and picture (`ManuallyDrop` with no matching drop).
/// One leak per corrupt file, on a path that also logs an error, is a price
/// worth paying to keep the process alive.
fn decode_obu_with_limit(obu: &[u8], frame_size_limit: u32) -> Result<Yuv> {
    let mut slots = ManuallyDrop::new(DecodeSlots::default());
    // `let`, not a `match` scrutinee: a temporary in a scrutinee lives to the
    // end of the match, and the closure's `&mut slots` borrow with it.
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        decode_into(obu, frame_size_limit, &mut slots)
    }));
    match outcome {
        Ok(result) => {
            // SAFETY: `slots` is live and has not been dropped — this is the
            // only drop, and only the non-panicking path reaches it.
            unsafe { ManuallyDrop::drop(&mut slots) };
            result
        }
        Err(payload) => Err(panicked(
            "AVIF decode panicked inside rav1d (corrupt stream)",
            payload,
        )),
    }
}

/// The body of `decode_obu_with_limit`, with every rav1d resource parked in
/// `slots` so its caller decides whether to release or leak them.
fn decode_into(obu: &[u8], frame_size_limit: u32, slots: &mut DecodeSlots) -> Result<Yuv> {
    let obu = non_empty_obu(obu)?;

    let mut settings = MaybeUninit::<Dav1dSettings>::uninit();
    // SAFETY: `settings` is a valid, writable location.
    unsafe { dav1d_default_settings(NonNull::new(settings.as_mut_ptr()).unwrap()) };
    // SAFETY: `dav1d_default_settings` unconditionally initialises `settings`.
    let mut settings = unsafe { settings.assume_init() };
    settings.n_threads = 1;
    settings.frame_size_limit = frame_size_limit;

    let ctx = slots.ctx.insert(DecodeContext::open(&mut settings)?).0;

    let mut pic = MaybeUninit::<Dav1dPicture>::zeroed();
    let rc = {
        let mut raw = MaybeUninit::<Dav1dData>::zeroed();
        // SAFETY: `raw` is a valid, writable location.
        let dst = unsafe { dav1d_data_create(NonNull::new(raw.as_mut_ptr()), obu.len()) };
        if dst.is_null() {
            return Err(err("dav1d_data_create returned null"));
        }
        // SAFETY: `dst` is a dav1d-allocated buffer of `obu.len()` bytes (the
        // null case, the only way it could be smaller or absent, returned
        // above); `obu` has `obu.len()` bytes to copy from.
        unsafe { std::ptr::copy_nonoverlapping(obu.as_ptr(), dst, obu.len()) };
        // SAFETY: `dav1d_data_create` fully wrote `raw` before returning
        // non-null. Parked in `slots` so every exit from here on either
        // releases dav1d's ref or deliberately leaks it.
        let data = &mut slots.data.insert(DataGuard(unsafe { raw.assume_init() })).0;

        // SAFETY: `ctx` is an open context; `data` and `pic` are valid locals.
        let mut rc = unsafe { dav1d_send_data(ctx, NonNull::new(&mut *data)) };
        if rc.0 != 0 && rc.0 != EAGAIN {
            return Err(err(format!("dav1d_send_data failed ({})", rc.0)));
        }
        // SAFETY: same as above.
        rc = unsafe { dav1d_get_picture(ctx, NonNull::new(pic.as_mut_ptr())) };
        let mut attempts = 0;
        while rc.0 == EAGAIN && attempts < 16 {
            if data.sz > 0 {
                // SAFETY: same as above.
                let _ = unsafe { dav1d_send_data(ctx, NonNull::new(&mut *data)) };
            }
            // SAFETY: same as above.
            rc = unsafe { dav1d_get_picture(ctx, NonNull::new(pic.as_mut_ptr())) };
            attempts += 1;
        }
        rc
    };
    if rc.0 != 0 {
        return Err(err(format!("dav1d_get_picture failed ({})", rc.0)));
    }
    // Input is fully consumed (or intentionally abandoned on `EAGAIN`
    // exhaustion) either way — release dav1d's ref before touching output.
    slots.data = None;

    // SAFETY: `rc.0 == 0` means dav1d fully populated `pic`.
    // Parked in `slots` alongside the context, same contract as the input.
    let pic = slots.pic.insert(PictureGuard(unsafe { pic.assume_init() }));
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
    // `slots` still holds the picture and the context; `decode_obu_with_limit`
    // releases them (picture first, then context) now that the caller is back
    // on the non-panicking path.
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
    fn frame_size_limit_rejects_frames_larger_than_the_ceiling() {
        let rgb = gradient_rgb(64, 48);
        let bytes = crate::avif::encode(64, 48, &rgb, 60).unwrap();
        let data = parse_container(&bytes).unwrap();
        // Control: the shipped ceiling decodes this 3,072-pixel frame.
        assert!(decode_obu_with_limit(&data.primary_item, AVIF_MAX_FRAME_PIXELS).is_ok());
        // A ceiling below the frame's pixel count fails as a clean `Err`
        // rather than allocating the planes — which is what protects us from
        // an AVIF whose frame header declares an absurd size.
        let Err(e) = decode_obu_with_limit(&data.primary_item, 1024) else {
            panic!("a 1,024-pixel ceiling must reject a 3,072-pixel frame");
        };
        assert!(format!("{e}").contains("dav1d"), "unexpected error: {e}");
    }
}
