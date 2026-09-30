//! Header-derived Sharp metadata (#3590), shared by byte and seekable inputs.

use crate::metadata_source::{MetadataSource, SeekableSource};
use serde::Serialize;
use std::io::{BufRead, Seek};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeaderFields {
    #[serde(skip)]
    pub grayscale: bool,
    #[serde(skip)]
    pub source_channels: Option<u8>,
    pub is_progressive: bool,
    pub is_palette: bool,
    pub bits_per_sample: Option<u8>,
    pub palette_bit_depth: Option<u8>,
    pub chroma_subsampling: Option<String>,
    pub pages: Option<usize>,
    pub page_primary: Option<usize>,
    pub compression: Option<&'static str>,
    pub resolution_unit: Option<&'static str>,
}

pub(crate) fn read<R: BufRead + Seek>(
    reader: &mut R,
    format: &str,
) -> std::io::Result<HeaderFields> {
    let source = SeekableSource::new(reader)?;
    let fields = match format {
        "jpeg" => jpeg(&source),
        "png" => png(&source),
        "tiff" | "dng" => tiff::fields(&source),
        "avif" => avif::fields(&source),
        "webp" => webp(&source),
        "gif" => crate::raster_metadata_gif::read(&source)
            .map(|gif| HeaderFields {
                is_palette: true,
                bits_per_sample: Some(gif.bits),
                palette_bit_depth: Some(gif.bits),
                pages: Some(gif.pages),
                ..Default::default()
            })
            .unwrap_or_default(),
        _ => HeaderFields::default(),
    };
    source.finish(fields)
}

pub(crate) fn exif_unit(bytes: &[u8]) -> Option<&'static str> {
    tiff::unit(bytes, false)
}

fn png(bytes: &impl MetadataSource) -> HeaderFields {
    let bits = bytes.byte(24);
    let palette = bytes.byte(25) == Some(3);
    HeaderFields {
        is_progressive: bytes.byte(28) == Some(1),
        is_palette: palette,
        bits_per_sample: bits,
        palette_bit_depth: if palette { bits } else { None },
        ..Default::default()
    }
}

fn jpeg(bytes: &impl MetadataSource) -> HeaderFields {
    let mut at = 2usize;
    while bytes.byte(at) == Some(255) {
        while bytes.byte(at) == Some(255) {
            let Some(next) = at.checked_add(1) else { break };
            at = next;
        }
        let Some(marker) = bytes.byte(at) else { break };
        at += 1;
        if matches!(marker, 0xda | 0xd9) {
            break;
        }
        if matches!(marker, 0x01 | 0xd0..=0xd7) {
            continue;
        }
        let Some(length) = bytes.get(at..at.saturating_add(2)) else {
            break;
        };
        let length = usize::from(u16::from_be_bytes([length[0], length[1]]));
        let Some(end) = at
            .checked_add(length)
            .filter(|&end| length >= 2 && end <= bytes.len())
        else {
            break;
        };
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let Some(sof) = bytes.get(at + 2..end) else {
                break;
            };
            let n = sof.get(5).copied().unwrap_or(0) as usize;
            let subsampling = if n == 1 {
                Some("4:4:4".into())
            } else if n >= 3 && sof.len() >= 6 + 3 * n {
                let y = sof[7];
                let c = sof[10];
                let (yh, yv, ch, cv) = (y >> 4, y & 15, c >> 4, c & 15);
                if yh == 0 || yv == 0 || ch == 0 || cv == 0 {
                    None
                } else {
                    let horizontal = 4 * ch / yh;
                    let vertical = if yv == cv { horizontal } else { 0 };
                    let suffix = if n == 4 {
                        format!(":{}", 4 * (sof[16] >> 4) / yh)
                    } else {
                        String::new()
                    };
                    Some(format!("4:{horizontal}:{vertical}{suffix}"))
                }
            } else {
                None
            };
            return HeaderFields {
                is_progressive: matches!(marker, 0xc2 | 0xc6 | 0xca | 0xce),
                chroma_subsampling: subsampling,
                ..Default::default()
            };
        }
        at = end;
    }
    HeaderFields::default()
}

#[path = "raster_metadata_avif.rs"]
mod avif;
#[path = "raster_metadata_tiff.rs"]
mod tiff;

fn webp(bytes: &impl MetadataSource) -> HeaderFields {
    let mut at = 12usize;
    let mut pages = 0usize;
    while let Some(header) = bytes.get(at..at.saturating_add(8)) {
        let size = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let Some(end) = at
            .checked_add(8)
            .and_then(|at| at.checked_add(size))
            .filter(|&end| end <= bytes.len())
        else {
            break;
        };
        if &header[..4] == b"ANMF" {
            pages += 1;
        }
        let Some(next) = end.checked_add(size & 1) else {
            break;
        };
        at = next;
    }
    HeaderFields {
        pages: (pages > 0).then_some(pages),
        ..Default::default()
    }
}

pub(crate) fn source_channels<S: MetadataSource + ?Sized>(bytes: &S) -> Option<u8> {
    tiff::source_channels(bytes)
}
