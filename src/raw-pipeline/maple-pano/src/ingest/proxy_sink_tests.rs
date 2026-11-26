use raw_core::PanoBlockSink;

use super::*;
use crate::ingest::proxy::proxy_to_long_edge;
use crate::ingest::ValidityMask;

/// Values spread over several binades, so a different summation order
/// would round differently.
fn frame(w: u32, h: u32) -> Vec<[f32; 3]> {
    let mut state = 0x9e37_79b9_u64;
    (0..w as usize * h as usize)
        .map(|_| {
            let mut next = || {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                let mantissa = (state >> 40) as f32 / (1u64 << 24) as f32;
                mantissa * 2f32.powi(((state >> 20) % 24) as i32 - 12)
            };
            [next(), next(), next()]
        })
        .collect()
}

fn planar(w: u32, h: u32, pixels: &[[f32; 3]]) -> PlanarImage {
    PlanarImage::from_planes(
        w,
        h,
        pixels.iter().map(|p| p[0]).collect(),
        pixels.iter().map(|p| p[1]).collect(),
        pixels.iter().map(|p| p[2]).collect(),
        ValidityMask::new_filled(w, h, true),
    )
}

/// Rows `y0..y1` (full width).
fn row_block(pixels: &[[f32; 3]], w: u32, y0: u32, y1: u32) -> Vec<[f32; 3]> {
    pixels[(y0 * w) as usize..(y1 * w) as usize].to_vec()
}

/// Columns `x0..x1` (full height), row-major `x1 - x0` wide.
fn col_block(pixels: &[[f32; 3]], w: u32, h: u32, x0: u32, x1: u32) -> Vec<[f32; 3]> {
    (0..h)
        .flat_map(|y| pixels[(y * w + x0) as usize..(y * w + x1) as usize].to_vec())
        .collect()
}

/// Band edges `0, band, 2·band, …, len`.
fn bands(len: u32, band: u32) -> Vec<(u32, u32)> {
    (0..len)
        .step_by(band as usize)
        .map(|a| (a, (a + band).min(len)))
        .collect()
}

fn assert_identical(got: &PlanarImage, want: &PlanarImage, case: &str) {
    assert_eq!(
        (got.width(), got.height()),
        (want.width(), want.height()),
        "{case}"
    );
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    assert_eq!(bits(&got.r), bits(&want.r), "{case}: R");
    assert_eq!(bits(&got.g), bits(&want.g), "{case}: G");
    assert_eq!(bits(&got.b), bits(&want.b), "{case}: B");
    assert!(got.validity.all_valid(), "{case}: validity");
}

fn run(
    w: u32,
    h: u32,
    edge: u32,
    blocks: impl IntoIterator<Item = (u32, u32, u32, Vec<[f32; 3]>)>,
) -> raw_core::Result<(PlanarImage, (u32, u32))> {
    let mut sink = ProxySink::new(edge);
    sink.begin(w, h)?;
    for (x0, y0, bw, block) in blocks {
        sink.put_block(x0, y0, bw, &block)?;
    }
    sink.finish()
}

#[test]
fn row_and_column_blocks_in_either_order_match_the_whole_frame_downscale() {
    for (w, h, edge) in [
        (97, 61, 23),
        (61, 97, 23),
        (64, 48, 16),
        (50, 30, 50),
        (41, 29, 7),
    ] {
        let pixels = frame(w, h);
        let want = proxy_to_long_edge(&planar(w, h, &pixels), edge);
        for band in [1, 5, 16, 33, 200] {
            let rows = bands(h, band);
            let cols = bands(w, band);
            let cases: [(&str, Vec<(u32, u32, u32, Vec<[f32; 3]>)>); 4] = [
                (
                    "rows down",
                    rows.iter()
                        .map(|&(a, b)| (0, a, w, row_block(&pixels, w, a, b)))
                        .collect(),
                ),
                (
                    "rows up",
                    rows.iter()
                        .rev()
                        .map(|&(a, b)| (0, a, w, row_block(&pixels, w, a, b)))
                        .collect(),
                ),
                (
                    "columns right",
                    cols.iter()
                        .map(|&(a, b)| (a, 0, b - a, col_block(&pixels, w, h, a, b)))
                        .collect(),
                ),
                (
                    "columns left",
                    cols.iter()
                        .rev()
                        .map(|&(a, b)| (a, 0, b - a, col_block(&pixels, w, h, a, b)))
                        .collect(),
                ),
            ];
            for (name, blocks) in cases {
                let (got, dims) = run(w, h, edge, blocks).expect(name);
                assert_eq!(dims, (w, h));
                assert_identical(&got, &want, &format!("{w}x{h} → {edge}, {band}-px {name}"));
            }
        }
    }
}

#[test]
fn a_whole_frame_block_matches_too() {
    let (w, h) = (73, 45);
    let pixels = frame(w, h);
    let want = proxy_to_long_edge(&planar(w, h, &pixels), 20);
    let (got, _) = run(w, h, 20, [(0, 0, w, pixels)]).expect("whole frame");
    assert_identical(&got, &want, "whole frame");
}

#[test]
fn the_sink_holds_only_the_straddling_lines_between_blocks() {
    let (w, h, edge) = (400, 300, 40);
    let pixels = frame(w, h);
    let mut sink = ProxySink::new(edge);
    sink.begin(w, h).expect("begin");
    sink.put_block(0, 0, w, &row_block(&pixels, w, 0, 105))
        .expect("block");
    let held: usize = sink
        .state
        .as_ref()
        .expect("begun")
        .pending
        .iter()
        .map(|p| p.pixels.len())
        .sum();
    assert_eq!(held, 5 * w as usize, "rows 100..105 of proxy row 10");
}

#[test]
fn an_unfinished_frame_is_an_error() {
    let (w, h) = (40, 30);
    let pixels = frame(w, h);
    let err = run(w, h, 10, [(0, 0, w, row_block(&pixels, w, 0, 20))]);
    assert!(err.is_err());
}

#[test]
fn a_block_that_is_neither_rows_nor_columns_is_an_error() {
    let mut sink = ProxySink::new(10);
    sink.begin(40, 30).expect("begin");
    assert!(sink.put_block(5, 5, 10, &[[0.0; 3]; 100]).is_err());
}
