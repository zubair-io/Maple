use super::decoder_free_preview;
use crate::image::ExifOrientation;
use crate::test_support::synth_jpeg::{jpeg, without_huffman_tables};
use image::DynamicImage;
use rawler::rawsource::RawSource;

const MIN_FALLBACK_LONG_EDGE: u32 = super::MIN_FALLBACK_LONG_EDGE;

fn oracle_decoder_free_preview(raw_bytes: &[u8]) -> Option<(DynamicImage, ExifOrientation)> {
    use rawler::formats::tiff::reader::TiffReader;
    use rawler::tags::TiffCommonTag;
    let tiff =
        rawler::formats::tiff::GenericTiffReader::new_with_buffer(raw_bytes, 0, 0, None).ok()?;
    let orientation = tiff
        .root_ifd()
        .get_entry(TiffCommonTag::Orientation)
        .map(|entry| ExifOrientation::from_u16(entry.force_u16(0)))
        .unwrap_or(ExifOrientation::Normal);
    let source = rawler::rawsource::RawSource::new_from_slice(raw_bytes);
    tiff.find_ifds_with_filter(|_| true)
        .into_iter()
        .filter_map(|ifd| ifd_display_image(ifd, &source))
        .max_by_key(|image| u64::from(image.width()) * u64::from(image.height()))
        .filter(|image| image.width().max(image.height()) >= MIN_FALLBACK_LONG_EDGE)
        .map(|image| (image, orientation))
}

fn ifd_display_image(
    ifd: &rawler::formats::tiff::IFD,
    source: &rawler::rawsource::RawSource<'_>,
) -> Option<image::DynamicImage> {
    use rawler::tags::TiffCommonTag;
    const PHOTOMETRIC_RGB: u16 = 2;
    const PHOTOMETRIC_YCBCR: u16 = 6;
    const UNCOMPRESSED: u16 = 1;
    let tag = |t: TiffCommonTag| ifd.get_entry(t).map(|entry| entry.force_u32(0));
    let photometric = tag(TiffCommonTag::PhotometricInt)? as u16;
    let displayable = matches!(photometric, PHOTOMETRIC_RGB | PHOTOMETRIC_YCBCR)
        && tag(TiffCommonTag::SamplesPerPixel) == Some(3)
        && ifd.contains_singlestrip_image();
    if !displayable {
        return None;
    }
    let strip = ifd.singlestrip_data_rawsource(source).ok()?;
    if tag(TiffCommonTag::Compression).map_or(UNCOMPRESSED, |c| c as u16) != UNCOMPRESSED {
        return image::load_from_memory_with_format(strip, image::ImageFormat::Jpeg).ok();
    }
    let width = tag(TiffCommonTag::ImageWidth)?;
    let height = tag(TiffCommonTag::ImageLength)?;
    let len = usize::try_from(u64::from(width) * u64::from(height) * 3).ok()?;
    let eight_bit = tag(TiffCommonTag::BitsPerSample) == Some(8);
    (photometric == PHOTOMETRIC_RGB && eight_bit && strip.len() >= len)
        .then(|| image::RgbImage::from_raw(width, height, strip[..len].to_vec()))
        .flatten()
        .map(image::DynamicImage::ImageRgb8)
}

fn assert_same(
    a: &Option<(DynamicImage, ExifOrientation)>,
    b: &Option<(DynamicImage, ExifOrientation)>,
) {
    match (a, b) {
        (None, None) => {}
        (Some((a, ao)), Some((b, bo))) => {
            assert_eq!(ao, bo);
            assert_eq!(
                (a.width(), a.height(), a.color()),
                (b.width(), b.height(), b.color())
            );
            assert!(a.as_bytes() == b.as_bytes(), "pixels differ");
        }
        _ => panic!("one side found a preview and the other did not"),
    }
}

enum Strip {
    Rgb { width: u32, height: u32, seed: u8 },
    Jpeg(Vec<u8>),
}

impl Strip {
    fn bytes(&self) -> Vec<u8> {
        match self {
            Self::Rgb {
                width,
                height,
                seed,
            } => (0..width * height * 3)
                .map(|i| (i as u8).wrapping_mul(*seed))
                .collect(),
            Self::Jpeg(bytes) => bytes.clone(),
        }
    }

    fn tags(&self, strip_at: u32, strip_len: u32) -> Vec<(u16, u16, u32)> {
        let (width, height, compression, photometric) = match self {
            Self::Rgb { width, height, .. } => (*width, *height, 1, 2),
            Self::Jpeg(bytes) => {
                let frame = crate::jpeg_frame::jpeg_frame(bytes);
                let (width, height) = frame.map_or((8, 8), |f| (f.width, f.height));
                (width, height, 7, 6)
            }
        };
        vec![
            (256, 4, width),
            (257, 4, height),
            (258, 3, 8),
            (259, 3, compression),
            (262, 3, photometric),
            (273, 4, strip_at),
            (277, 3, 3),
            (278, 4, height),
            (279, 4, strip_len),
        ]
    }
}

fn tiff_chain(strips: &[Strip]) -> Vec<u8> {
    const IFD_LEN: u32 = 2 + 12 * 9 + 4;
    let payloads = strips.iter().map(Strip::bytes).collect::<Vec<_>>();
    let data_start = 8 + IFD_LEN * strips.len() as u32;
    let strip_at = payloads
        .iter()
        .scan(data_start, |at, p| {
            let start = *at;
            *at += p.len() as u32;
            Some(start)
        })
        .collect::<Vec<_>>();
    let directories = strips.iter().enumerate().flat_map(|(n, strip)| {
        let next = if n + 1 < strips.len() {
            8 + IFD_LEN * (n as u32 + 1)
        } else {
            0
        };
        let entries = strip
            .tags(strip_at[n], payloads[n].len() as u32)
            .into_iter()
            .flat_map(|(tag, ty, value)| {
                let value = if ty == 3 {
                    u32::from(value as u16)
                } else {
                    value
                };
                [
                    tag.to_le_bytes().to_vec(),
                    ty.to_le_bytes().to_vec(),
                    1u32.to_le_bytes().to_vec(),
                    value.to_le_bytes().to_vec(),
                ]
                .concat()
            })
            .collect::<Vec<u8>>();
        [
            9u16.to_le_bytes().to_vec(),
            entries,
            next.to_le_bytes().to_vec(),
        ]
        .concat()
    });
    [
        vec![0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0],
        directories.collect(),
        payloads.concat(),
    ]
    .concat()
}

/// The ranked selection over an in-memory source, required to agree with the
/// same selection over a paged file of the same bytes.
fn ranked(bytes: &[u8]) -> Option<(DynamicImage, ExifOrientation)> {
    let in_memory = decoder_free_preview(&RawSource::new_from_borrowed_slice(bytes));
    #[cfg(not(target_arch = "wasm32"))]
    assert_same(&in_memory, &paged_ranked(bytes));
    in_memory
}

#[cfg(not(target_arch = "wasm32"))]
fn paged_ranked(bytes: &[u8]) -> Option<(DynamicImage, ExifOrientation)> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("chain.dng");
    std::fs::write(&path, bytes).unwrap();
    let file = crate::paged_file::PagedFile::new(std::fs::File::open(&path).unwrap()).unwrap();
    let source = RawSource::new_lazy(&file);
    let found = decoder_free_preview(&source);
    assert!(source.failure().is_none());
    found
}

fn check(strips: &[Strip]) -> Option<(DynamicImage, ExifOrientation)> {
    let bytes = tiff_chain(strips);
    let expected = oracle_decoder_free_preview(&bytes);
    let actual = ranked(&bytes);
    assert_same(&expected, &actual);
    actual
}

fn rgb(width: u32, height: u32, seed: u8) -> Strip {
    Strip::Rgb {
        width,
        height,
        seed,
    }
}

#[test]
fn chain_is_visible_to_the_reader() {
    use rawler::formats::tiff::reader::TiffReader;
    let bytes = tiff_chain(&[rgb(300, 200, 3), rgb(310, 200, 5), rgb(320, 200, 7)]);
    let tiff =
        rawler::formats::tiff::GenericTiffReader::new_with_buffer(&bytes, 0, 0, None).unwrap();
    assert_eq!(tiff.find_ifds_with_filter(|_| true).len(), 3);
}

#[test]
fn equal_area_candidates_keep_the_last() {
    let jpeg_strip = jpeg(300, 200, true, 1);
    let winner = check(&[rgb(300, 200, 3), Strip::Jpeg(jpeg_strip.clone())]).unwrap();
    assert!(winner.0.as_bytes() == image::load_from_memory(&jpeg_strip).unwrap().as_bytes());
    let winner = check(&[Strip::Jpeg(jpeg_strip), rgb(300, 200, 3)]).unwrap();
    assert!(winner.0.as_bytes() == rgb(300, 200, 3).bytes().as_slice());
}

#[test]
fn largest_wins_wherever_it_sits() {
    let big = jpeg(640, 480, true, 2);
    [
        vec![Strip::Jpeg(big.clone()), rgb(300, 200, 3), rgb(320, 240, 5)],
        vec![rgb(300, 200, 3), Strip::Jpeg(big.clone()), rgb(320, 240, 5)],
        vec![rgb(300, 200, 3), rgb(320, 240, 5), Strip::Jpeg(big)],
    ]
    .iter()
    .for_each(|strips| {
        let winner = check(strips).unwrap();
        assert_eq!((winner.0.width(), winner.0.height()), (640, 480));
    });
}

#[test]
fn undecodable_largest_falls_through_to_the_next() {
    let broken = without_huffman_tables(&jpeg(800, 600, true, 3));
    assert!(crate::jpeg_frame::jpeg_frame(&broken).is_some());
    assert!(image::load_from_memory_with_format(&broken, image::ImageFormat::Jpeg).is_err());
    let winner = check(&[Strip::Jpeg(broken), rgb(300, 200, 3), rgb(280, 200, 5)]).unwrap();
    assert_eq!((winner.0.width(), winner.0.height()), (300, 200));
}

#[test]
fn undecodable_largest_with_only_thumbnails_left_yields_none() {
    let broken = without_huffman_tables(&jpeg(800, 600, true, 4));
    assert!(check(&[Strip::Jpeg(broken), rgb(100, 100, 3)]).is_none());
}

#[test]
fn largest_below_the_thumbnail_edge_is_refused() {
    assert!(check(&[rgb(200, 200, 3), rgb(100, 100, 5)]).is_none());
}

#[test]
fn a_smaller_candidate_with_a_long_enough_edge_does_not_replace_a_refused_winner() {
    assert!(check(&[rgb(250, 250, 3), rgb(300, 100, 5)]).is_none());
    let broken = without_huffman_tables(&jpeg(800, 600, true, 6));
    assert!(check(&[Strip::Jpeg(broken), rgb(250, 250, 3), rgb(300, 100, 5)]).is_none());
}

#[test]
fn grayscale_jpeg_in_a_three_sample_ifd_is_still_a_candidate() {
    let gray = jpeg(500, 400, false, 5);
    let winner = check(&[rgb(300, 200, 3), Strip::Jpeg(gray)]).unwrap();
    assert_eq!((winner.0.width(), winner.0.height()), (500, 400));
}

#[test]
fn unreadable_jpeg_strips_are_dropped_like_failed_decodes() {
    let garbage = Strip::Jpeg(vec![0xFF, 0xD8, 0xFF, 0x00, 0x12, 0x34]);
    let winner = check(&[garbage, rgb(300, 200, 3)]).unwrap();
    assert_eq!((winner.0.width(), winner.0.height()), (300, 200));
}

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn a_chain_cut_short_after_opening_reports_the_read_instead_of_a_preview() {
    let bytes = tiff_chain(&[rgb(1024, 768, 1), rgb(300, 200, 2)]);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("chain.dng");
    std::fs::write(&path, &bytes).unwrap();
    let file = crate::paged_file::PagedFile::new(std::fs::File::open(&path).unwrap()).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .and_then(|f| f.set_len(bytes.len() as u64 - 16))
        .unwrap();
    let result = super::extract_embedded_preview_from(RawSource::new_lazy(&file), "dng");
    assert!(
        matches!(result, Err(crate::Error::Io { .. })),
        "a fetch that failed must not yield a preview: {:?}",
        result.map(|(image, _)| (image.width(), image.height()))
    );
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn fixture_corpus_resolves_like_the_full_decode() {
    let files = crate::test_support::fixtures::raw_files();
    assert!(!files.is_empty());
    let tiff_files = files
        .iter()
        .filter(|path| {
            std::fs::File::open(path)
                .and_then(|mut f| {
                    let mut magic = [0u8; 4];
                    std::io::Read::read_exact(&mut f, &mut magic).map(|_| magic)
                })
                .is_ok_and(|magic| crate::view::auto_profile::preview::is_tiff_container(&magic))
        })
        .collect::<Vec<_>>();
    let found = tiff_files
        .iter()
        .map(|path| {
            let bytes = std::fs::read(path).unwrap();
            let expected = oracle_decoder_free_preview(&bytes);
            assert_same(&expected, &ranked(&bytes));
            expected.is_some()
        })
        .filter(|resolved| *resolved)
        .count();
    assert!(found > 0, "no TIFF fixture resolved a preview");
    eprintln!(
        "compared {} TIFF files, {found} with a preview",
        tiff_files.len()
    );
}
