//! Per-RAW embedded-preview coverage for the Auto Profile audit (#5458):
//! every source's yield, the winner with and without exiftool, the sensor
//! size and the preview colour space. Diagnostic only; extraction itself
//! stays in [`super::preview`].

use std::path::Path;

use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;
use serde::Serialize;

use super::preview::{
    detect_jpeg_color_space_from_rawsource, extract_preview_via_exiftool, JpegColorSpace,
};
use super::preview_sources::{extract_in_process, PreviewSource};

#[derive(Clone, Debug, Serialize)]
pub struct SourceYield {
    pub source: PreviewSource,
    /// `[width, height]` of the decoded preview, sensor-oriented; `None` when
    /// this source produced no image.
    pub size: Option<[u32; 2]>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PreviewCoverage {
    pub make: String,
    pub model: String,
    pub format: String,
    /// Display-oriented DefaultCrop size, when the metadata yields one.
    pub sensor: Option<[u32; 2]>,
    pub color_space: &'static str,
    /// Every source in extraction order, exiftool last.
    pub sources: Vec<SourceYield>,
}

impl PreviewCoverage {
    /// The source extraction picks: the first that yields an image. Without
    /// exiftool this is what the sandboxed Apple app, iOS and Web/WASM get.
    pub fn winner(&self, with_exiftool: bool) -> Option<&SourceYield> {
        self.sources
            .iter()
            .filter(|s| with_exiftool || s.source != PreviewSource::Exiftool)
            .find(|s| s.size.is_some())
    }
}

/// True for the file extensions rawler can decode, case-insensitively.
pub fn is_supported_raw(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| {
            rawler::decoders::supported_extensions()
                .iter()
                .any(|s| s.eq_ignore_ascii_case(ext))
        })
}

/// Evaluate every preview source for the RAW at `path`. Errors only when the
/// file cannot be read or no decoder recognises it.
pub fn preview_coverage(path: &Path) -> Result<PreviewCoverage, String> {
    let src = RawSource::new(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let decoder = rawler::get_decoder(&src).map_err(|e| format!("{}: {e}", path.display()))?;
    let meta = decoder.raw_metadata(&src, &RawDecodeParams::default()).ok();
    let size_of = |img: image::DynamicImage| [img.width(), img.height()];
    let in_process = PreviewSource::IN_PROCESS
        .into_iter()
        .map(|source| SourceYield {
            source,
            size: extract_in_process(source, decoder.as_ref(), &src).map(size_of),
        });
    let exiftool = SourceYield {
        source: PreviewSource::Exiftool,
        size: extract_preview_via_exiftool(path).map(size_of),
    };
    Ok(PreviewCoverage {
        make: meta.as_ref().map(|m| m.make.clone()).unwrap_or_default(),
        model: meta.as_ref().map(|m| m.model.clone()).unwrap_or_default(),
        format: format!("{:?}", decoder.format_hint()),
        sensor: crate::raw_dimensions::from_source(&src).ok(),
        color_space: match detect_jpeg_color_space_from_rawsource(&src) {
            JpegColorSpace::SRgb => "sRGB",
            JpegColorSpace::AdobeRgb => "Adobe RGB",
        },
        sources: in_process.chain(std::iter::once(exiftool)).collect(),
    })
}
