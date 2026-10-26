//! The ordered embedded-preview sources the Auto Profile fit draws from.
//! Extraction ([`super::preview`]) takes the first source that yields an
//! image; the coverage audit ([`super::preview_coverage`]) evaluates every one
//! of them against the same per-source code, so the audit can never disagree
//! with the product about which source wins (#5458).

use image::DynamicImage;
use rawler::decoders::{Decoder, FormatHint, RawDecodeParams};
use rawler::rawsource::RawSource;
use serde::Serialize;

use super::preview::{is_tiff_container, largest_embedded_jpeg};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewSource {
    /// rawler `preview_image()`; unimplemented for every rawler 0.7.2 decoder,
    /// kept to pick up native support if a future rawler adds it.
    PreviewImage,
    /// rawler `full_image()`: the camera's embedded preview image (CR2/CR3,
    /// DNG preview sub-IFD, NEF/ARW largest JPEG IFD, RAF, RW2, MRW, PEF, FFF).
    FullImage,
    /// rawler `thumbnail_image()` for DNGs whose reduced-res preview lives in
    /// the root IFD (e.g. Apple/iPhone), which `full_image` misses (#930).
    DngThumbnail,
    /// Largest colour JPEG in a non-TIFF container (e.g. Sigma X3F), gated so
    /// it can never return a TIFF RAW-as-JPEG (#930).
    EmbeddedJpegScan,
    /// `exiftool -PreviewImage` / `-JpgFromRaw`; path variant only. Absent in
    /// the sandboxed Apple app, on iOS and on Web/WASM (#927).
    Exiftool,
}

impl PreviewSource {
    /// Every source the sandboxed Apple app, iOS and Web/WASM can reach, in
    /// the order extraction tries them.
    pub const IN_PROCESS: [Self; 4] = [
        Self::PreviewImage,
        Self::FullImage,
        Self::DngThumbnail,
        Self::EmbeddedJpegScan,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::PreviewImage => "preview_image",
            Self::FullImage => "full_image",
            Self::DngThumbnail => "dng_thumbnail",
            Self::EmbeddedJpegScan => "jpeg_scan",
            Self::Exiftool => "exiftool",
        }
    }
}

/// The image one in-process source yields for `src`, or `None`. The exiftool
/// source needs a filesystem path and is evaluated by its caller instead.
pub(super) fn extract_in_process(
    source: PreviewSource,
    decoder: &dyn Decoder,
    src: &RawSource<'_>,
) -> Option<DynamicImage> {
    let params = RawDecodeParams::default();
    match source {
        PreviewSource::PreviewImage => decoder.preview_image(src, &params).ok().flatten(),
        PreviewSource::FullImage => decoder.full_image(src, &params).ok().flatten(),
        // `thumbnail_image`'s trait default logs a warning for every non-DNG
        // decoder, so it is only asked where the root-IFD preview can exist.
        PreviewSource::DngThumbnail if decoder.format_hint() == FormatHint::DNG => {
            decoder.thumbnail_image(src, &params).ok().flatten()
        }
        PreviewSource::DngThumbnail => None,
        PreviewSource::EmbeddedJpegScan if !is_tiff_container(src.buf()) => {
            largest_embedded_jpeg(src.buf())
        }
        PreviewSource::EmbeddedJpegScan | PreviewSource::Exiftool => None,
    }
}
