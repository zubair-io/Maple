//! Bandwidth-vs-compute measurement harness for `downsample_image_area`
//! (#1089 item 4).
//!
//! This epic already burned one implementation (the NLM column-prefix
//! parallelization) that was provably bit-identical and still regressed the
//! live tick, because that pass was memory-bandwidth-bound rather than
//! compute-bound. The recorded lesson is that every remaining perf claim
//! needs an empirical bandwidth-vs-compute check *before* a patch is written.
//! This harness is that check for the downsample.
//!
//! It reports, per size:
//!   * median wall time for the serial (`main`) implementation,
//!   * median wall time for a row-parallel prototype,
//!   * compulsory DRAM traffic and the achieved bandwidth implied by it,
//!   * the filter-tap rate (taps/s), the compute-side counterpart,
//!   * FNV-1a hashes of both output buffers, so any speedup claim is
//!     accompanied by a byte-identity proof rather than an assumption.
//!
//! Usage:
//!   cargo run --release -p raw-core --example downsample-bench -- [runs]
//!
//! A `runs` of 1 is useful for the 100MP case when iterating; the default of
//! 5 is what the ticket numbers were taken from.

use raw_core::image::{ColorSpace, Image};
use raw_core::pipeline::downsample_image_area;
use std::time::Instant;

/// Mitchell-Netravali (B=C=1/3), byte-for-byte the closure in
/// `pipeline/downsample.rs`. Duplicated here rather than exported because
/// exporting it purely for a bench would be speculative API surface.
fn mitchell(x: f32) -> f32 {
    let ax = x.abs();
    let b = 1.0 / 3.0;
    let c = 1.0 / 3.0;
    if ax < 1.0 {
        ((12.0 - 9.0 * b - 6.0 * c) * ax * ax * ax
            + (-18.0 + 12.0 * b + 6.0 * c) * ax * ax
            + (6.0 - 2.0 * b))
            / 6.0
    } else if ax < 2.0 {
        ((-b - 6.0 * c) * ax * ax * ax
            + (6.0 * b + 30.0 * c) * ax * ax
            + (-12.0 * b - 48.0 * c) * ax
            + (8.0 * b + 24.0 * c))
            / 6.0
    } else {
        0.0
    }
}

/// Destination extent for a long-edge cap, matching the production rounding.
fn dest_dims(sw: u32, sh: u32, max_long_edge: u32) -> (u32, u32) {
    if sw >= sh {
        let scale = max_long_edge as f64 / sw as f64;
        (max_long_edge, ((sh as f64 * scale).round() as u32).max(1))
    } else {
        let scale = max_long_edge as f64 / sh as f64;
        (((sw as f64 * scale).round() as u32).max(1), max_long_edge)
    }
}

/// Serial reference: the exact loop structure on `main`.
fn serial(src: &[[f32; 3]], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<[f32; 3]> {
    let scale_x = sw as f32 / dw as f32;
    let scale_y = sh as f32 / dh as f32;

    let mut horiz = vec![[0.0f32; 3]; dw * sh];
    let radius_x = 2.0 * scale_x;
    for y in 0..sh {
        for x in 0..dw {
            let x_src = (x as f32 + 0.5) * scale_x - 0.5;
            let x0 = (x_src - radius_x).floor() as isize;
            let x1 = (x_src + radius_x).ceil() as isize;
            let mut sum_r = 0.0f32;
            let mut sum_g = 0.0f32;
            let mut sum_b = 0.0f32;
            let mut sum_w = 0.0f32;
            for sx in x0..=x1 {
                let sx_clamped = sx.clamp(0, (sw - 1) as isize) as usize;
                let weight = mitchell((sx as f32 - x_src) / scale_x);
                let p = src[y * sw + sx_clamped];
                sum_r += p[0] * weight;
                sum_g += p[1] * weight;
                sum_b += p[2] * weight;
                sum_w += weight;
            }
            let w_norm = if sum_w.abs() > 1e-6 { sum_w } else { 1.0 };
            horiz[y * dw + x] = [sum_r / w_norm, sum_g / w_norm, sum_b / w_norm];
        }
    }

    let mut out = vec![[0.0f32; 3]; dw * dh];
    let radius_y = 2.0 * scale_y;
    for y in 0..dh {
        let y_src = (y as f32 + 0.5) * scale_y - 0.5;
        let y0 = (y_src - radius_y).floor() as isize;
        let y1 = (y_src + radius_y).ceil() as isize;
        for x in 0..dw {
            let mut sum_r = 0.0f32;
            let mut sum_g = 0.0f32;
            let mut sum_b = 0.0f32;
            let mut sum_w = 0.0f32;
            for sy in y0..=y1 {
                let sy_clamped = sy.clamp(0, (sh - 1) as isize) as usize;
                let weight = mitchell((sy as f32 - y_src) / scale_y);
                let p = horiz[sy_clamped * dw + x];
                sum_r += p[0] * weight;
                sum_g += p[1] * weight;
                sum_b += p[2] * weight;
                sum_w += weight;
            }
            let w_norm = if sum_w.abs() > 1e-6 { sum_w } else { 1.0 };
            out[y * dw + x] = [sum_r / w_norm, sum_g / w_norm, sum_b / w_norm];
        }
    }
    out
}

/// The shipped implementation, called through its real entry point so the
/// hash comparison below is a genuine proof against `main`'s output rather
/// than against a second copy of the same code.
fn production(src: &[[f32; 3]], sw: usize, sh: usize, cap: u32) -> Vec<[f32; 3]> {
    let mut img = Image {
        width: sw as u32,
        height: sh as u32,
        pixels: src.to_vec(),
        space: ColorSpace::CameraNativeLinearRgb,
    };
    downsample_image_area(&mut img, cap);
    img.pixels
}

/// FNV-1a over the raw bytes of the output buffer. Byte-level, not
/// value-level, so a `-0.0` vs `0.0` or a NaN payload difference would show.
fn fnv1a(buf: &[[f32; 3]]) -> u64 {
    let bytes = unsafe {
        std::slice::from_raw_parts(buf.as_ptr() as *const u8, std::mem::size_of_val(buf))
    };
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| {
        (h ^ b as u64).wrapping_mul(0x1000_0000_01b3)
    })
}

/// Deterministic scene-linear-ish content with real high-frequency detail, so
/// nothing short-circuits and the branchy Mitchell arms are all exercised.
fn make_src(sw: usize, sh: usize) -> Vec<[f32; 3]> {
    (0..sw * sh)
        .map(|i| {
            let x = (i % sw) as f32;
            let y = (i / sw) as f32;
            let n = ((i.wrapping_mul(2_654_435_761)) >> 8 & 0xffff) as f32 / 65535.0;
            [
                0.18 * (1.0 + 0.5 * (x * 0.031).sin()) + 0.05 * n,
                0.18 * (1.0 + 0.5 * (y * 0.027).cos()) + 0.05 * n,
                0.18 * (1.0 + 0.5 * ((x + y) * 0.019).sin()) + 0.05 * n,
            ]
        })
        .collect()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let runs: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);

    println!("threads (rayon): {}", rayon::current_num_threads());
    println!("runs per case  : {runs}\n");

    // (label, source w, source h, long-edge cap)
    //  - the 2MP case is a Preview-tier buffer already near the cap: the
    //    shape the live tick sees.
    //  - the 25MP case is the half-res Preview decode of a 100MP frame,
    //    which is what the cold-open fast phase actually feeds in.
    //  - the 100MP case is the full-res sensor buffer (refine phase).
    let cases: [(&str, usize, usize, u32); 3] = [
        ("2MP  -> 1600", 1728, 1152, 1600),
        ("25MP -> 1600", 5828, 4371, 1600),
        ("100MP-> 1600", 11656, 8742, 1600),
    ];

    for (label, sw, sh, cap) in cases {
        let src = make_src(sw, sh);
        let (dw32, dh32) = dest_dims(sw as u32, sh as u32, cap);
        let (dw, dh) = (dw32 as usize, dh32 as usize);

        let t_ser = median(
            (0..runs)
                .map(|_| {
                    let t = Instant::now();
                    let o = serial(&src, sw, sh, dw, dh);
                    let e = t.elapsed().as_secs_f64();
                    std::hint::black_box(&o);
                    e
                })
                .collect(),
        );
        let t_par = median(
            (0..runs)
                .map(|_| {
                    // Build the input outside the timed region so the two
                    // timings cover the same work — `serial` is handed a
                    // borrowed slice and never pays for a copy of the source.
                    let mut img = Image {
                        width: sw as u32,
                        height: sh as u32,
                        pixels: src.clone(),
                        space: ColorSpace::CameraNativeLinearRgb,
                    };
                    let t = Instant::now();
                    downsample_image_area(&mut img, cap);
                    let e = t.elapsed().as_secs_f64();
                    std::hint::black_box(&img.pixels);
                    e
                })
                .collect(),
        );

        let h_ser = fnv1a(&serial(&src, sw, sh, dw, dh));
        let h_par = fnv1a(&production(&src, sw, sh, cap));

        // Compulsory DRAM traffic: read the source once, write the
        // intermediate, read it back, write the destination. Reuse inside a
        // row's filter footprint is cache-resident, so it is not DRAM traffic.
        let px = 12.0; // [f32; 3]
        let bytes = (sw * sh) as f64 * px          // source read
            + (dw * sh) as f64 * px * 2.0          // intermediate write + read
            + (dw * dh) as f64 * px; // destination write

        // Compute side: one Mitchell evaluation per filter tap.
        let taps_x = (4.0 * (sw as f64 / dw as f64)).floor() + 2.0;
        let taps_y = (4.0 * (sh as f64 / dh as f64)).floor() + 2.0;
        let taps = (dw * sh) as f64 * taps_x + (dw * dh) as f64 * taps_y;

        println!("{label}  ({sw}x{sh} -> {dw}x{dh})");
        println!(
            "  serial  : {:8.3} ms   {:6.1} GB/s compulsory   {:6.2} Gtap/s",
            t_ser * 1e3,
            bytes / t_ser / 1e9,
            taps / t_ser / 1e9
        );
        println!(
            "  prod(par): {:8.3} ms   {:6.1} GB/s compulsory   {:6.2} Gtap/s   speedup {:.2}x",
            t_par * 1e3,
            bytes / t_par / 1e9,
            taps / t_par / 1e9,
            t_ser / t_par
        );
        println!(
            "  traffic : {:.1} MB compulsory, {:.0} M taps ({:.0} taps/x, {:.0} taps/y)",
            bytes / 1e6,
            taps / 1e6,
            taps_x,
            taps_y
        );
        println!(
            "  hash    : serial {h_ser:016x}  parallel {h_par:016x}  {}\n",
            if h_ser == h_par {
                "IDENTICAL"
            } else {
                "*** DIVERGENT ***"
            }
        );
    }
}
