//! Byte-identity pins for the Tier-1 thumbnail path (#3502).
//!
//! The API renders its `thumb`/`preview` derivatives through
//! `maple_raster_render_buf` with BOTH axes set, a centre position and the
//! lanczos3 kernel — `fit: 'inside'` for previews, `fit: 'cover'` for square
//! grid thumbnails. The resize-mode work in #3502 changed how the target box
//! is resolved (single-axis shrink, clamp precedence, crop rounding), and
//! none of it may move those two renders by a single byte. These hashes were
//! computed at d16df9655, BEFORE that work landed, and must keep holding
//! after it.
//!
//! The fixture is chosen so the arithmetic is exact on both paths and the
//! answer cannot depend on a rounding convention:
//!
//! * 64x32 source into a 16x16 box.
//! * `inside`: shrink = max(64/16, 32/16) = 4 -> 16x8, an exact power of two
//!   on both axes.
//! * `cover`: shrink = min(4, 2) = 2 -> 32x16, then a centre crop to 16x16.
//!   The horizontal slack is 32 - 16 = 16, an EVEN number, so sharp's
//!   round-up centring `(in - out + 1) / 2` and the round-down centring it
//!   replaced both land on left = 8. Odd-slack crops do move by design —
//!   that is the #3502 fix, pinned separately in raw-core's resize tests.
//!
//! A hash mismatch here means one of: the resize arithmetic moved, the
//! resampler's weights moved, the JPEG encoder was upgraded, or the embedded
//! sRGB ICC profile changed (`icc::profile_for`, embedded by
//! `encode_raster_rgb`). All are worth a deliberate look; none should happen
//! silently. The encoded LENGTH stays a stronger signal for the first three,
//! since the ICC profile is a fixed 6684-byte block — a length-only match
//! with a hash mismatch points at the profile, not the resize.
//!
//! Re-pinned 2026-09-13 after #3582 fixed `icc.rs`'s `trc_tag()` (it was
//! writing the OETF into a curve tag that must hold the EOTF, making every
//! ICC-tagged export render ~2x too bright in a colour-managed reader).
//! That changed the embedded profile's bytes with no change to pixel
//! placement — confirmed by an empty `raster_resize.rs` / `raster_geometry.rs`
//! / `raster_composite.rs` diff across the fix. The encoded length held
//! (7378 / 7392), only the hash moved.

use super::*;
use std::ffi::CString;

/// Deterministic 64x32 RGB gradient — every column and row carries a
/// different value, so a one-pixel shift in either axis changes the hash.
fn fixture_png() -> Vec<u8> {
    let data: Vec<u8> = (0..32u32)
        .flat_map(|y| {
            (0..64u32).flat_map(move |x| [(x * 4) as u8, (y * 8) as u8, ((x + y) * 3 % 256) as u8])
        })
        .collect();
    let raster = raw_core::raster::RasterImage::new_rgb(64, 32, data);
    raw_core::export::encode_raster(&raster, raw_core::export::ExportFormat::Png, 0).unwrap()
}

/// Render the fixture at 16x16 with the given flag word and return the
/// BLAKE3 of the encoded JPEG.
fn render_hash(flags: u32) -> (String, usize) {
    let png = fixture_png();
    let fmt = CString::new("jpeg").unwrap();
    let mut len = 0usize;
    // SAFETY: every pointer below is live for the call, and `out_len` is a
    // valid writable slot.
    let rc = unsafe {
        maple_raster_render_buf(
            png.as_ptr(),
            png.len(),
            16,
            16,
            flags,
            0, // lanczos3
            fmt.as_ptr(),
            80,
            0,
            std::ptr::null_mut(),
            0,
            &mut len,
        )
    };
    assert_eq!(rc, NEED_LARGER_BUFFER, "probe call must report the size");
    let mut out = vec![0u8; len];
    // SAFETY: `out` is `len` bytes long, exactly the size the probe reported.
    let rc = unsafe {
        maple_raster_render_buf(
            png.as_ptr(),
            png.len(),
            16,
            16,
            flags,
            0,
            fmt.as_ptr(),
            80,
            0,
            out.as_mut_ptr(),
            out.len(),
            &mut len,
        )
    };
    assert_eq!(rc, 0, "render must succeed");
    out.truncate(len);
    (blake3::hash(&out).to_hex().to_string(), len)
}

#[test]
fn tier_1_inside_thumbnail_bytes_are_pinned() {
    let (hash, len) = render_hash(0);
    assert_eq!(len, 7378, "encoded length moved: {hash}");
    assert_eq!(
        hash,
        "abaeb9428ba6ff830c1485ecd09ea32154535d67ee9302fdafc89d5e7cb0a38b"
    );
}

#[test]
fn tier_1_cover_thumbnail_bytes_are_pinned() {
    let (hash, len) = render_hash(FLAG_COVER);
    assert_eq!(len, 7392, "encoded length moved: {hash}");
    assert_eq!(
        hash,
        "51311a9ce529f487b3728f087258eff15bf5f09e7ec6db37c6b9b2c4c624c7f1"
    );
}
