use super::*;
use crate::raster_encode_jpeg::JpegOptions;
use crate::raster_encode_png::PngOptions;
use crate::raster_encode_tiff::TiffOptions;
use crate::raster_meta::read_sidecars;

fn meta(
    icc: Option<&[u8]>,
    exif: Option<&[u8]>,
    xmp: Option<&[u8]>,
    density: Option<f64>,
) -> ResolvedMetadata {
    // Every existing call site here means "whatever is Some was named by
    // the caller" — the swept-vs-named distinction (fix-round-2 for ICC,
    // final fix wave item 6 for EXIF and XMP) gets its own dedicated tests
    // below, not a change to this helper's meaning.
    ResolvedMetadata {
        icc: icc.map(|b| b.to_vec()),
        exif: exif.map(|b| b.to_vec()),
        xmp: xmp.map(|b| b.to_vec()),
        density,
        exif_requested: exif.is_some(),
        icc_requested: icc.is_some(),
        xmp_requested: xmp.is_some(),
    }
}

const EXIF_TIFF: &[u8] = b"II\x2a\x00\x08\x00\x00\x00\x00\x00";
const XMP_PACKET: &[u8] = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"/>"#;

fn p3() -> Vec<u8> {
    crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3)
}

fn rgb(width: u32, height: u32, value: u8) -> RasterImage {
    RasterImage::new_rgb(width, height, vec![value; (width * height * 3) as usize])
}

#[test]
fn jpeg_embeds_icc_exif_and_xmp() {
    let icc = p3();
    let bytes = encode_raster_output(
        &rgb(2, 2, 90),
        &RasterOutput::Jpeg(JpegOptions::default()),
        &meta(Some(&icc), Some(EXIF_TIFF), Some(XMP_PACKET), None),
    )
    .unwrap();
    let found = read_sidecars(&bytes);
    assert_eq!(found.icc.as_deref(), Some(icc.as_slice()));
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert_eq!(found.xmp.as_deref(), Some(XMP_PACKET));
}

/// fix-round-1, item 2: a `None` icc means NO icc, full stop — no more
/// "leave the container's own default profile tagging alone." Adding a
/// default sRGB profile when the caller asked to `keep` is
/// `resolve_metadata`'s job (see its own tests), not this encoder's.
#[test]
fn jpeg_with_no_resolved_metadata_embeds_none_at_all() {
    let bytes = encode_raster_output(
        &rgb(2, 2, 90),
        &RasterOutput::Jpeg(JpegOptions::default()),
        &meta(None, None, None, None),
    )
    .unwrap();
    let found = read_sidecars(&bytes);
    assert!(found.icc.is_none(), "an untagged JPEG grew an ICC profile");
    assert!(found.exif.is_none());
    assert!(found.xmp.is_none());
}

#[test]
fn jpeg_writes_the_requested_density() {
    let bytes = encode_raster_output(
        &rgb(2, 2, 90),
        &RasterOutput::Jpeg(JpegOptions::default()),
        &meta(None, None, None, Some(300.0)),
    )
    .unwrap();
    let density = read_sidecars(&bytes).density.unwrap();
    assert!((density - 300.0).abs() < 0.01, "got: {density}");
}

#[test]
fn png_embeds_icc_exif_xmp_and_density() {
    let icc = p3();
    let bytes = encode_raster_output(
        &rgb(2, 2, 120),
        &RasterOutput::Png(PngOptions::default()),
        &meta(Some(&icc), Some(EXIF_TIFF), Some(XMP_PACKET), Some(72.0)),
    )
    .unwrap();
    let found = read_sidecars(&bytes);
    assert_eq!(found.icc.as_deref(), Some(icc.as_slice()));
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert_eq!(found.xmp.as_deref(), Some(XMP_PACKET));
    assert!(
        (found.density.unwrap() - 72.0).abs() < 0.01,
        "got: {:?}",
        found.density
    );
}

#[test]
fn png_keeps_the_alpha_channel() {
    let rgba = RasterImage::new_rgba(2, 2, [0u8, 255, 0, 0].repeat(4));
    let bytes = encode_raster_output(
        &rgba,
        &RasterOutput::Png(PngOptions::default()),
        &meta(None, None, None, None),
    )
    .unwrap();
    let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
    assert_eq!(decoded.channels, 4);
    assert_eq!(decoded.data[3], 0);
}

/// PR-F's WebP arm embedded nothing at all — it was the one container that
/// silently dropped a profile the caller asked for. `image`'s `WebPEncoder`
/// has both setters, so it now behaves like JPEG/PNG/TIFF (#3507).
#[cfg(feature = "avif")]
#[test]
fn webp_embeds_icc_and_exif_but_stays_untagged_without_them() {
    let icc = p3();
    let tagged = encode_raster_output(
        &rgb(2, 2, 64),
        &RasterOutput::Webp { lossless: true },
        &meta(Some(&icc), Some(EXIF_TIFF), None, None),
    )
    .unwrap();
    let found = read_sidecars(&tagged);
    assert_eq!(found.icc.as_deref(), Some(icc.as_slice()));
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));

    let untagged = encode_raster_output(
        &rgb(2, 2, 64),
        &RasterOutput::Webp { lossless: true },
        &meta(None, None, None, None),
    )
    .unwrap();
    assert!(read_sidecars(&untagged).icc.is_none());
}

#[test]
fn tiff_embeds_the_icc_profile() {
    let icc = p3();
    let bytes = encode_raster_output(
        &rgb(2, 2, 200),
        &RasterOutput::Tiff(TiffOptions::default()),
        &meta(Some(&icc), None, None, None),
    )
    .unwrap();
    assert_eq!(read_sidecars(&bytes).icc.as_deref(), Some(icc.as_slice()));
}

#[cfg(feature = "avif")]
#[test]
fn avif_embeds_exif() {
    let bytes = encode_raster_output(
        &rgb(4, 4, 50),
        &RasterOutput::Avif(crate::raster_encode_avif::AvifOptions::default()),
        &meta(None, Some(EXIF_TIFF), None, None),
    )
    .unwrap();
    assert_eq!(read_sidecars(&bytes).exif.as_deref(), Some(EXIF_TIFF));
}

/// `RasterOutput::Webp { lossless: false }` must fail regardless of
/// whether the `avif` feature is on: the feature-on path rejects lossy
/// WebP by name (Maple's encoder is lossless-only), and the feature-off
/// path rejects the whole output by name (no encoder module at all).
#[test]
fn webp_lossy_is_refused_through_the_output_enum() {
    assert!(encode_raster_output(
        &rgb(2, 1, 3),
        &RasterOutput::Webp { lossless: false },
        &ResolvedMetadata::default()
    )
    .is_err());
}

/// #3506 F6: with the `avif` feature off, `lossless: true` — the one
/// value that DOES succeed once the feature is on — must still fail by
/// name: there is no WebP encoder at all without the feature (it shares
/// `raster_encode_avif`'s module with AVIF, see `encode_webp_lossless`),
/// so this isolates the feature gate itself as the failure reason,
/// distinct from the lossless-value check
/// `webp_lossy_is_refused_through_the_output_enum` above exercises with
/// `lossless: false` (which fails either way, for two different reasons
/// depending on the feature).
#[cfg(not(feature = "avif"))]
#[test]
fn webp_lossless_output_without_the_avif_feature_is_a_named_error() {
    let err = encode_raster_output(
        &rgb(2, 1, 3),
        &RasterOutput::Webp { lossless: true },
        &ResolvedMetadata::default(),
    )
    .unwrap_err();
    assert!(
        format!("{err}").contains("avif"),
        "expected the error to name the missing 'avif' feature, got: {err}"
    );
}

#[test]
fn a_jpeg_output_flattens_alpha_over_black() {
    let rgba = RasterImage::new_rgba(8, 8, vec![0, 255, 0, 0].repeat(64));
    let bytes = encode_raster_output(
        &rgba,
        &RasterOutput::Jpeg(JpegOptions::default()),
        &ResolvedMetadata::default(),
    )
    .unwrap();
    let decoded = crate::raster::decode_raster(&bytes, Some("jpeg")).unwrap();
    assert!(decoded.data[..3].iter().all(|&v| v < 24));
}

#[test]
fn tiff_with_no_resolved_icc_embeds_none() {
    let bytes = encode_raster_output(
        &rgb(2, 2, 200),
        &RasterOutput::Tiff(TiffOptions::default()),
        &meta(None, None, None, None),
    )
    .unwrap();
    assert!(read_sidecars(&bytes).icc.is_none());
}

// ---- require_supported (fix-round-1, item 1) ----

#[test]
fn webp_rejects_xmp_and_density_by_name() {
    let err = require_supported(
        &meta(None, None, Some(XMP_PACKET), None),
        "WebP",
        &WEBP_CAPS,
    )
    .unwrap_err();
    assert!(
        format!("{err}").contains("WebP cannot embed XMP"),
        "got: {err}"
    );

    let err =
        require_supported(&meta(None, None, None, Some(72.0)), "WebP", &WEBP_CAPS).unwrap_err();
    assert!(
        format!("{err}").contains("WebP cannot embed a pixel density"),
        "got: {err}"
    );
}

#[test]
fn webp_accepts_icc_and_exif() {
    let icc = p3();
    require_supported(
        &meta(Some(&icc), Some(EXIF_TIFF), None, None),
        "WebP",
        &WEBP_CAPS,
    )
    .unwrap();
}

#[test]
fn tiff_rejects_exif_xmp_and_density_by_name() {
    let err = require_supported(&meta(None, Some(EXIF_TIFF), None, None), "TIFF", &TIFF_CAPS)
        .unwrap_err();
    assert!(
        format!("{err}").contains("TIFF cannot embed EXIF"),
        "got: {err}"
    );

    let err = require_supported(
        &meta(None, None, Some(XMP_PACKET), None),
        "TIFF",
        &TIFF_CAPS,
    )
    .unwrap_err();
    assert!(
        format!("{err}").contains("TIFF cannot embed XMP"),
        "got: {err}"
    );

    let err =
        require_supported(&meta(None, None, None, Some(72.0)), "TIFF", &TIFF_CAPS).unwrap_err();
    assert!(
        format!("{err}").contains("TIFF cannot embed a pixel density"),
        "got: {err}"
    );
}

#[test]
fn tiff_accepts_icc() {
    let icc = p3();
    require_supported(&meta(Some(&icc), None, None, None), "TIFF", &TIFF_CAPS).unwrap();
}

#[test]
fn avif_rejects_icc_xmp_and_density_by_name() {
    let icc = p3();
    let err =
        require_supported(&meta(Some(&icc), None, None, None), "AVIF", &AVIF_CAPS).unwrap_err();
    assert!(
        format!("{err}").contains("AVIF cannot embed an ICC profile"),
        "got: {err}"
    );

    let err = require_supported(
        &meta(None, None, Some(XMP_PACKET), None),
        "AVIF",
        &AVIF_CAPS,
    )
    .unwrap_err();
    assert!(
        format!("{err}").contains("AVIF cannot embed XMP"),
        "got: {err}"
    );

    let err =
        require_supported(&meta(None, None, None, Some(72.0)), "AVIF", &AVIF_CAPS).unwrap_err();
    assert!(
        format!("{err}").contains("AVIF cannot embed a pixel density"),
        "got: {err}"
    );
}

#[test]
fn avif_accepts_exif() {
    require_supported(&meta(None, Some(EXIF_TIFF), None, None), "AVIF", &AVIF_CAPS).unwrap();
}

/// The gate runs inside the ONE encode path, not only as a standalone
/// function: a TIFF output with a resolved EXIF block fails there by name.
#[test]
fn the_encode_path_itself_applies_the_gate() {
    let err = encode_raster_output(
        &rgb(2, 2, 200),
        &RasterOutput::Tiff(TiffOptions::default()),
        &meta(None, Some(EXIF_TIFF), None, None),
    )
    .unwrap_err();
    assert!(
        format!("{err}").contains("TIFF cannot embed EXIF"),
        "got: {err}"
    );
}
