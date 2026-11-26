use super::largest_embedded_jpeg;
use crate::test_support::synth_jpeg::{jpeg, without_huffman_tables};
use image::DynamicImage;

fn oracle_largest_embedded_jpeg(bytes: &[u8]) -> Option<DynamicImage> {
    const MIN_EDGE: u32 = 256;
    let mut best: Option<DynamicImage> = None;
    let mut best_area: u64 = 0;
    let mut i = 0usize;
    while i + 2 < bytes.len() {
        if bytes[i] == 0xFF && bytes[i + 1] == 0xD8 && bytes[i + 2] == 0xFF {
            if let Ok(img) =
                image::load_from_memory_with_format(&bytes[i..], image::ImageFormat::Jpeg)
            {
                let (w, h) = (img.width(), img.height());
                let is_color = !matches!(
                    img.color(),
                    image::ColorType::L8
                        | image::ColorType::L16
                        | image::ColorType::La8
                        | image::ColorType::La16
                );
                let area = u64::from(w) * u64::from(h);
                if is_color && w >= MIN_EDGE && h >= MIN_EDGE && area > best_area {
                    best_area = area;
                    best = Some(img);
                }
            }
        }
        i += 1;
    }
    best
}

fn assert_same(a: &Option<DynamicImage>, b: &Option<DynamicImage>) {
    match (a, b) {
        (None, None) => {}
        (Some(a), Some(b)) => {
            assert_eq!(
                (a.width(), a.height(), a.color()),
                (b.width(), b.height(), b.color())
            );
            assert!(a.as_bytes() == b.as_bytes(), "pixels differ");
        }
        _ => panic!("one side found a preview and the other did not"),
    }
}

fn container(parts: &[&[u8]]) -> Vec<u8> {
    parts
        .iter()
        .flat_map(|part| [&b"FOVb\x00\x01junk"[..], part, &[0u8; 5][..]].concat())
        .collect()
}

fn check(bytes: &[u8]) -> Option<DynamicImage> {
    let expected = oracle_largest_embedded_jpeg(bytes);
    let actual = largest_embedded_jpeg(bytes);
    assert_same(&expected, &actual);
    actual
}

#[test]
fn equal_area_candidates_keep_the_first() {
    let first = jpeg(320, 256, true, 1);
    let second = jpeg(256, 320, true, 2);
    let third = jpeg(320, 256, true, 3);
    let winner = check(&container(&[&first, &second, &third])).unwrap();
    let alone = image::load_from_memory(&first).unwrap();
    assert!(winner.as_bytes() == alone.as_bytes());
}

#[test]
fn larger_later_candidate_beats_an_earlier_one() {
    let small = jpeg(300, 300, true, 4);
    let large = jpeg(400, 300, true, 5);
    let winner = check(&container(&[&small, &large])).unwrap();
    assert_eq!((winner.width(), winner.height()), (400, 300));
}

#[test]
fn header_valid_but_undecodable_largest_falls_through() {
    let broken = without_huffman_tables(&jpeg(600, 500, true, 6));
    assert!(crate::jpeg_frame::jpeg_frame(&broken).is_some());
    assert!(image::load_from_memory_with_format(&broken, image::ImageFormat::Jpeg).is_err());
    let next = jpeg(400, 300, true, 7);
    let tail = jpeg(300, 300, true, 8);
    let winner = check(&container(&[&broken, &next, &tail])).unwrap();
    assert_eq!((winner.width(), winner.height()), (400, 300));
}

#[test]
fn only_undecodable_candidates_yield_none() {
    let broken = without_huffman_tables(&jpeg(600, 500, true, 9));
    assert!(check(&container(&[&broken])).is_none());
}

#[test]
fn grayscale_largest_is_skipped() {
    let gray = jpeg(800, 600, false, 10);
    let color = jpeg(300, 300, true, 11);
    let winner = check(&container(&[&gray, &color])).unwrap();
    assert_eq!((winner.width(), winner.height()), (300, 300));
    assert!(check(&container(&[&gray])).is_none());
}

#[test]
fn candidates_below_the_minimum_edge_are_skipped() {
    let thin = jpeg(255, 900, true, 12);
    let ok = jpeg(256, 256, true, 13);
    let winner = check(&container(&[&thin, &ok])).unwrap();
    assert_eq!((winner.width(), winner.height()), (256, 256));
    assert!(check(&container(&[&thin])).is_none());
}

#[test]
fn false_positive_start_markers_are_ignored() {
    let real = jpeg(300, 280, true, 14);
    let noise = [
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x12, 0x34, 0xFF, 0xD8, 0xFF, 0xFF, 0xD8, 0xFF,
    ];
    let winner = check(&container(&[&noise, &real, &noise])).unwrap();
    assert_eq!((winner.width(), winner.height()), (300, 280));
    assert!(check(&noise).is_none());
    assert!(check(&[]).is_none());
}

#[test]
fn a_start_marker_inside_another_jpeg_is_a_candidate_too() {
    let inner = jpeg(280, 280, true, 15);
    let mut outer = jpeg(500, 400, true, 16);
    outer.splice(20..20, inner.iter().copied());
    check(&container(&[&outer]));
    check(&container(&[&inner, &outer]));
}

#[test]
fn corrupted_headers_resolve_like_the_full_decode() {
    let base = jpeg(264, 256, true, 17);
    let fallback = jpeg(256, 256, true, 18);
    let header_len = base.windows(2).position(|w| w == [0xFF, 0xDA]).unwrap() + 24;
    (0..header_len)
        .filter(|at| *at < 30 || at % 17 == 0 || *at > header_len - 30)
        .for_each(|at| {
            [0x00u8, 0x04, 0xFF].into_iter().for_each(|value| {
                let mutated = [&base[..at], &[value], &base[at + 1..]].concat();
                check(&container(&[&mutated, &fallback]));
            });
        });
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn fixture_corpus_resolves_like_the_full_decode() {
    let files = crate::test_support::fixtures::raw_files();
    assert!(!files.is_empty());
    files.iter().for_each(|path| {
        let bytes = std::fs::read(path).unwrap();
        let expected = oracle_largest_embedded_jpeg(&bytes);
        assert_same(&expected, &largest_embedded_jpeg(&bytes));
    });
    eprintln!("compared {} files", files.len());
}
