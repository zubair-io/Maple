use image::{codecs::jpeg::JpegEncoder, ExtendedColorType};

fn noise(seed: u32, i: u32) -> u8 {
    let x = (seed ^ i).wrapping_mul(2_654_435_761);
    (x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223) >> 24) as u8
}

pub fn jpeg(width: u32, height: u32, color: bool, seed: u32) -> Vec<u8> {
    let channels = if color { 3 } else { 1 };
    let pixels = (0..width * height * channels)
        .map(|i| {
            let p = i / channels;
            ((p % width) as u8)
                .wrapping_add((p / width) as u8)
                .wrapping_add(noise(seed, i) / 8)
        })
        .collect::<Vec<_>>();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 90)
        .encode(
            &pixels,
            width,
            height,
            if color {
                ExtendedColorType::Rgb8
            } else {
                ExtendedColorType::L8
            },
        )
        .unwrap();
    out
}

/// The header still parses but the full decode fails.
pub fn without_huffman_tables(jpeg: &[u8]) -> Vec<u8> {
    let scan = jpeg
        .windows(2)
        .position(|w| w == [0xFF, 0xDA])
        .expect("start of scan");
    let mut out = jpeg.to_vec();
    out[..scan]
        .windows(2)
        .enumerate()
        .filter(|(_, w)| *w == [0xFF, 0xC4])
        .map(|(at, _)| at)
        .collect::<Vec<_>>()
        .into_iter()
        .for_each(|at| out[at + 1] = 0xFE);
    out
}
