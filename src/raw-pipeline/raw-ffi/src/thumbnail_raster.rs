//! Color-managed unedited JPEG/TIFF thumbnails (#3891).
use raw_core::{
    image::{ColorSpace, Image},
    view::encode::{self, TargetPrimaries},
};
use rawler::rawsource::RawSource;

pub(super) fn is_raster(source: &RawSource<'_>, ext: &str) -> bool {
    if source
        .subview(0, 3)
        .is_ok_and(|head| head == [0xff, 0xd8, 0xff])
    {
        return true;
    }
    if !matches!(ext, "tif" | "tiff") {
        return false;
    }
    // A RAW stored in TIFF must retain the camera-preview path, even when
    // no embedded preview exists. Format probing avoids a full sensor decode.
    let hint = format!("source.{ext}");
    let probe =
        RawSource::new_from_borrowed_slice(source.buf()).with_path(std::path::Path::new(&hint));
    matches!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || rawler::get_decoder(&probe).is_err()
        )),
        Ok(true)
    )
}

pub(super) fn pixels(bytes: &[u8], max_px: u32) -> raw_core::Result<(u32, u32, Vec<u8>)> {
    let (width, height, rgba) =
        raw_core::pipeline::decode_raster_base(bytes, max_px, raw_core::CancelToken::never())?;
    let mut image = Image::new(width, height, ColorSpace::DisplayLinearRec2020);
    for (pixel, p) in image.pixels.iter_mut().zip(rgba.chunks_exact(4)) {
        *pixel = [p[0], p[1], p[2]];
    }
    encode::rec2020_to_display(&mut image, TargetPrimaries::Srgb);
    encode::srgb_gamma_encode(&mut image);
    let rgb = image
        .pixels
        .iter()
        .flat_map(|p| p.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8))
        .collect();
    Ok((width, height, rgb))
}
