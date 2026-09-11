//! PNG encode with sharp's options (#3506): zlib compression level, adaptive
//! row filtering, and an optional palette (indexed) output with
//! Floyd-Steinberg dithering.
//!
//! The quantiser is a median cut over the image's own colours — pure Rust, no
//! `imagequant` (which is C). It is not as good as pngquant on photographs;
//! it is exact for images that already have `colours` or fewer distinct
//! colours, which is the case `palette: true` is actually used for (logos,
//! screenshots, flat art).

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use png::{AdaptiveFilterType, BitDepth, ColorType, Compression, Encoder};

/// sharp's `png()` options that a pure-Rust encoder can honour. `progressive`
/// (Adam7 interlacing) is rejected by name at the recipe layer: the `png`
/// crate's streaming encoder does not write interlaced images.
#[derive(Clone, Copy, Debug)]
pub struct PngOptions {
    /// zlib level 0 (fastest, largest) to 9 (slowest, smallest).
    pub compression_level: u8,
    pub adaptive_filtering: bool,
    pub palette: bool,
    /// Palette entries, 2..=256. Ignored unless `palette`.
    pub colours: u16,
    /// Floyd-Steinberg error diffusion, 0.0 (off) to 1.0 (full).
    pub dither: f64,
}

impl Default for PngOptions {
    fn default() -> Self {
        Self {
            compression_level: 6,
            adaptive_filtering: false,
            palette: false,
            colours: 256,
            dither: 1.0,
        }
    }
}

/// XMP inside a PNG lives in an `iTXt` chunk with this exact keyword.
const XMP_KEYWORD: &str = "XML:com.adobe.xmp";

fn png_error(e: impl std::fmt::Display) -> Error {
    Error::Png(format!("png encode failed: {e}"))
}

/// Map sharp's 0-9 to the `png` crate's tiers. Unlike `flate2`, the `png`
/// crate does not expose a raw 1-9 zlib level — 0.17's [`Compression`] enum
/// has exactly three non-deprecated variants (`Fast`, `Default`, `Best`,
/// mapping respectively to `flate2::Compression::{fast,default,best}`), so
/// sharp's scale is bucketed into thirds: 0 is fastest/largest, 1-5 sits on
/// zlib's own default, and 6-9 (including this module's default of 6) is the
/// smallest/slowest tier.
fn compression_for(level: u8) -> Compression {
    match level {
        0 => Compression::Fast,
        1..=5 => Compression::Default,
        _ => Compression::Best,
    }
}

pub fn encode_png_opts(
    raster: &RasterImage,
    options: &PngOptions,
    icc: Option<&[u8]>,
    exif: Option<&[u8]>,
    xmp: Option<&[u8]>,
) -> Result<Vec<u8>> {
    if options.palette && !(2..=256).contains(&options.colours) {
        return Err(png_error(format!(
            "palette colours {} must be between 2 and 256",
            options.colours
        )));
    }
    let mut out: Vec<u8> = Vec::new();
    {
        // `png` 0.17's `Encoder` has no `set_icc_profile` / `set_exif_metadata`
        // setters — those two fields exist only on `Info` with no dedicated
        // builder method — so the `Info` is built directly and handed to
        // `Encoder::with_info` instead of mutating an `Encoder::new` default.
        let mut info = png::Info::with_size(raster.width, raster.height);
        info.icc_profile = icc.map(|profile| profile.to_vec().into());
        info.exif_metadata = exif.map(|block| block.to_vec().into());
        let mut encoder = Encoder::with_info(&mut out, info).map_err(png_error)?;
        encoder.set_compression(compression_for(options.compression_level));
        encoder.set_adaptive_filter(if options.adaptive_filtering {
            AdaptiveFilterType::Adaptive
        } else {
            AdaptiveFilterType::NonAdaptive
        });
        if let Some(packet) = xmp {
            let text = String::from_utf8_lossy(packet).to_string();
            encoder
                .add_itxt_chunk(XMP_KEYWORD.to_string(), text)
                .map_err(png_error)?;
        }
        let body = if options.palette {
            let (palette, indices) = quantise(raster, options.colours, options.dither);
            encoder.set_color(ColorType::Indexed);
            encoder.set_depth(BitDepth::Eight);
            encoder.set_palette(
                palette
                    .iter()
                    .flat_map(|c| [c[0], c[1], c[2]])
                    .collect::<Vec<u8>>(),
            );
            if palette.iter().any(|c| c[3] != 255) {
                encoder.set_trns(palette.iter().map(|c| c[3]).collect::<Vec<u8>>());
            }
            indices
        } else {
            encoder.set_color(if raster.channels == 4 {
                ColorType::Rgba
            } else {
                ColorType::Rgb
            });
            encoder.set_depth(BitDepth::Eight);
            raster.data.clone()
        };
        let mut writer = encoder.write_header().map_err(png_error)?;
        writer.write_image_data(&body).map_err(png_error)?;
        writer.finish().map_err(png_error)?;
    }
    Ok(out)
}

/// Median-cut quantisation to at most `colours` entries, with optional
/// Floyd-Steinberg error diffusion. Returns the palette (RGBA) and one index
/// per pixel.
///
/// Median cut, not k-means: it is O(n log k), deterministic, and exact when
/// the image already has `colours` or fewer distinct colours — which is the
/// case a palette PNG is actually chosen for.
pub(crate) fn quantise(raster: &RasterImage, colours: u16, dither: f64) -> (Vec<[u8; 4]>, Vec<u8>) {
    let c = raster.channels as usize;
    let pixels: Vec<[u8; 4]> = raster
        .data
        .chunks_exact(c)
        .map(|px| [px[0], px[1], px[2], *px.get(3).unwrap_or(&255)])
        .collect();

    // One box per split; each box is a slice of an index permutation.
    let mut boxes: Vec<Vec<usize>> = vec![(0..pixels.len()).collect()];
    while boxes.len() < colours as usize {
        // Split the box with the widest channel range; stop when none can be.
        let Some((at, channel)) = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.len() > 1)
            .filter_map(|(i, b)| {
                let widest = (0..4)
                    .map(|ch| {
                        let values = b.iter().map(|&p| pixels[p][ch]);
                        let lo = values.clone().min().unwrap_or(0);
                        let hi = values.max().unwrap_or(0);
                        (hi - lo, ch)
                    })
                    .max()?;
                (widest.0 > 0).then_some((widest.0, i, widest.1))
            })
            .max()
            .map(|(_, i, ch)| (i, ch))
        else {
            break;
        };
        let mut members = boxes.swap_remove(at);
        members.sort_unstable_by_key(|&p| pixels[p][channel]);
        let half = members.len() / 2;
        // Split at the value transition nearest the population median, not
        // at the population median itself: a straight member-count split can
        // land inside a run of identical values when a box's colours aren't
        // evenly distributed, averaging two distinct source colours into one
        // palette entry. `channel`'s range was checked > 0 above, so sorted
        // `members` has at least one transition to land on.
        let split_at = (1..members.len())
            .filter(|&i| pixels[members[i]][channel] != pixels[members[i - 1]][channel])
            .min_by_key(|&i| (i as isize - half as isize).abs())
            .expect("nonzero channel range implies at least one value transition");
        let upper = members.split_off(split_at);
        boxes.push(members);
        boxes.push(upper);
    }

    let palette: Vec<[u8; 4]> = boxes
        .iter()
        .map(|members| {
            let n = members.len().max(1) as u32;
            [0, 1, 2, 3]
                .map(|ch| (members.iter().map(|&p| pixels[p][ch] as u32).sum::<u32>() / n) as u8)
        })
        .collect();

    let nearest = |px: [f64; 4]| -> usize {
        palette
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| {
                let d = |c: &[u8; 4]| {
                    (0..4)
                        .map(|ch| (c[ch] as f64 - px[ch]).powi(2))
                        .sum::<f64>()
                };
                d(a).total_cmp(&d(b))
            })
            .map(|(i, _)| i)
            .unwrap_or(0)
    };

    if dither <= 0.0 {
        let indices = pixels
            .iter()
            .map(|px| nearest([0, 1, 2, 3].map(|ch| px[ch] as f64)) as u8)
            .collect();
        return (palette, indices);
    }

    // Floyd-Steinberg over a mutable working copy in f64.
    let (w, h) = (raster.width as usize, raster.height as usize);
    let mut work: Vec<[f64; 4]> = pixels
        .iter()
        .map(|px| [0, 1, 2, 3].map(|ch| px[ch] as f64))
        .collect();
    let mut indices = vec![0u8; pixels.len()];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let chosen = nearest(work[i]);
            indices[i] = chosen as u8;
            let error = [0, 1, 2, 3].map(|ch| (work[i][ch] - palette[chosen][ch] as f64) * dither);
            let mut spread = |tx: usize, ty: usize, weight: f64| {
                if tx < w && ty < h {
                    let t = ty * w + tx;
                    for ch in 0..4 {
                        work[t][ch] += error[ch] * weight;
                    }
                }
            };
            spread(x + 1, y, 7.0 / 16.0);
            if x > 0 {
                spread(x - 1, y + 1, 3.0 / 16.0);
            }
            spread(x, y + 1, 5.0 / 16.0);
            spread(x + 1, y + 1, 1.0 / 16.0);
        }
    }
    (palette, indices)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `n`x`n` image using exactly `k` distinct colours, in a repeating
    /// pattern so a quantiser cannot get lucky.
    fn palette_art(n: u32, k: u32) -> RasterImage {
        let data = (0..n * n)
            .flat_map(|i| {
                let c = (i % k) as u8;
                [c * 40, 255 - c * 40, 128]
            })
            .collect();
        RasterImage::new_rgb(n, n, data)
    }

    fn opts() -> PngOptions {
        PngOptions {
            compression_level: 6,
            adaptive_filtering: false,
            palette: false,
            colours: 256,
            dither: 1.0,
        }
    }

    #[test]
    fn encodes_a_truecolour_png_that_round_trips() {
        let src = palette_art(16, 5);
        let bytes = encode_png_opts(&src, &opts(), None, None, None).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
        assert_eq!(decoded.data, src.data, "truecolour PNG must be lossless");
    }

    #[test]
    fn rgba_round_trips_losslessly() {
        let src = RasterImage::new_rgba(2, 1, vec![10, 20, 30, 255, 40, 50, 60, 0]);
        let bytes = encode_png_opts(&src, &opts(), None, None, None).unwrap();
        let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
        assert_eq!((decoded.channels, decoded.data), (4, src.data));
    }

    #[test]
    fn a_higher_compression_level_produces_a_smaller_file() {
        let src = palette_art(64, 7);
        let fast = encode_png_opts(
            &src,
            &PngOptions {
                compression_level: 1,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        let best = encode_png_opts(
            &src,
            &PngOptions {
                compression_level: 9,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        assert!(
            best.len() <= fast.len(),
            "level 9 ({}) vs level 1 ({})",
            best.len(),
            fast.len()
        );
    }

    #[test]
    fn a_palette_png_is_indexed_and_smaller() {
        let src = palette_art(64, 6);
        let truecolour = encode_png_opts(&src, &opts(), None, None, None).unwrap();
        let indexed = encode_png_opts(
            &src,
            &PngOptions {
                palette: true,
                colours: 16,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        assert!(indexed.windows(4).any(|w| w == b"PLTE"), "no palette chunk");
        assert!(indexed.len() < truecolour.len());
    }

    #[test]
    fn a_palette_png_is_exact_when_the_image_fits_the_palette() {
        // 6 distinct colours into a 16-entry palette: no loss is possible.
        let src = palette_art(32, 6);
        let bytes = encode_png_opts(
            &src,
            &PngOptions {
                palette: true,
                colours: 16,
                dither: 0.0,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
        assert_eq!(decoded.to_rgb_bytes(), src.data);
    }

    #[test]
    fn a_palette_png_keeps_transparency() {
        let data = (0..16u32)
            .flat_map(|i| [200u8, 40, 40, if i % 2 == 0 { 255 } else { 0 }])
            .collect();
        let src = RasterImage::new_rgba(4, 4, data);
        let bytes = encode_png_opts(
            &src,
            &PngOptions {
                palette: true,
                colours: 8,
                dither: 0.0,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        assert!(
            bytes.windows(4).any(|w| w == b"tRNS"),
            "no transparency chunk"
        );
        let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
        assert_eq!(decoded.channels, 4);
        assert_eq!(decoded.data[3], 255);
        assert_eq!(decoded.data[7], 0);
    }

    #[test]
    fn the_metadata_chunks_are_embedded() {
        let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::Srgb);
        let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00".to_vec();
        let xmp = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"/>"#.to_vec();
        let bytes = encode_png_opts(
            &palette_art(8, 3),
            &opts(),
            Some(&icc),
            Some(&exif),
            Some(&xmp),
        )
        .unwrap();
        assert!(bytes.windows(4).any(|w| w == b"iCCP"), "no iCCP chunk");
        assert!(bytes.windows(4).any(|w| w == b"eXIf"), "no eXIf chunk");
        assert!(
            bytes.windows(4).any(|w| w == b"iTXt"),
            "no iTXt chunk for XMP"
        );
    }

    #[test]
    fn an_out_of_range_colour_count_is_rejected() {
        let src = palette_art(8, 3);
        assert!(encode_png_opts(
            &src,
            &PngOptions {
                palette: true,
                colours: 1,
                ..opts()
            },
            None,
            None,
            None
        )
        .is_err());
        assert!(encode_png_opts(
            &src,
            &PngOptions {
                palette: true,
                colours: 300,
                ..opts()
            },
            None,
            None,
            None
        )
        .is_err());
    }
}
