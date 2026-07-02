//! Standalone NLM timing + parity-dump harness for #1195.
//!
//! Times `denoise_plane` on the LUMA (P=2,S=2,h=0.04 → 24 shifts) and CHROMA
//! (P=2,S=3,h=0.05 → 48 shifts) production regimes at a 2 MP "tick" plane and a
//! ~100 MP "refine" plane, median of N runs, `--release`. Deterministic xorshift
//! noise so the SAME plane is fed on origin/main and the branch.
//!
//! It also dumps the raw f32 output of representative planes to a binary file
//! (`dump <path-prefix>`) so the branch's box-sum output can be loaded and diffed
//! against the committed integral-image output (the tolerance-vs-old proof).
//!
//! Usage:
//!   nlm_bench bench               # timing table (median ms)
//!   nlm_bench dump <path-prefix>  # write reference planes to <prefix>_<case>.f32

use raw_core::stages::nlm::{denoise_plane, NlmParams};
use std::time::Instant;

const LUMA: NlmParams = NlmParams {
    patch_radius: 2,
    search_radius: 2,
    h: 0.04,
};
const CHROMA: NlmParams = NlmParams {
    patch_radius: 2,
    search_radius: 3,
    h: 0.05,
};

/// Deterministic noisy plane around 0.5 — xorshift, platform-independent.
fn make_plane(w: usize, h: usize, seed: u32) -> Vec<f32> {
    let n = w * h;
    let mut v = vec![0.0f32; n];
    let mut rng = seed | 1;
    for px in v.iter_mut() {
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        // uniform [0,1) → noise around 0.5 with ~0.1 amplitude
        let u = (rng >> 8) as f32 / (1u32 << 24) as f32;
        *px = 0.5 + 0.1 * (u - 0.5);
    }
    v
}

fn median(mut xs: Vec<f64>) -> f64 {
    assert!(!xs.is_empty(), "median: empty sample set");
    xs.sort_by(f64::total_cmp);
    let mid = xs.len() / 2;
    if xs.len() % 2 == 0 {
        (xs[mid - 1] + xs[mid]) / 2.0
    } else {
        xs[mid]
    }
}

fn time_case(label: &str, w: usize, h: usize, params: NlmParams, runs: usize) {
    let plane = make_plane(w, h, 0xABCD_1234);
    // warm-up (allocator, page-faults, table init)
    let _ = denoise_plane(&plane, w, h, params);
    let mut ms = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t = Instant::now();
        let out = denoise_plane(&plane, w, h, params);
        let dt = t.elapsed().as_secs_f64() * 1e3;
        std::hint::black_box(&out);
        ms.push(dt);
    }
    let med = median(ms.clone());
    let min = ms.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = ms.iter().cloned().fold(0.0, f64::max);
    println!(
        "{label:<28} {w}x{h:<6} median={med:8.2}ms  min={min:8.2}ms  max={max:8.2}ms  (n={runs})"
    );
}

fn dump_case(prefix: &str, case: &str, w: usize, h: usize, params: NlmParams) {
    let plane = make_plane(w, h, 0xABCD_1234);
    let out = denoise_plane(&plane, w, h, params);
    let path = format!("{prefix}_{case}.f32");
    let bytes: Vec<u8> = out.iter().flat_map(|f| f.to_le_bytes()).collect();
    std::fs::write(&path, &bytes).expect("write dump");
    println!("dumped {case} ({w}x{h}) -> {path} ({} floats)", out.len());
}

/// f64 ground-truth NLM — naive O(N·S²·P²) with full f64 accumulation of the
/// patch-SSD, weights, and the per-pixel average. Slow, but exact enough to be
/// the reference both f32 implementations are graded against. Mirrors the same
/// algorithm `denoise_plane` runs (same `fast_neg_exp` semantics via `(-x).exp()`
/// clamped to the LUT's range/sign conventions, same self-similarity centre).
fn truth_case(prefix: &str, case: &str, w: usize, h: usize, params: NlmParams) {
    let plane = make_plane(w, h, 0xABCD_1234);
    let p = params.patch_radius as isize;
    let s = params.search_radius as isize;
    let patch_area = ((2 * params.patch_radius + 1) * (2 * params.patch_radius + 1)) as f64;
    let h_sq = (params.h as f64) * (params.h as f64);
    let inv_norm = 1.0 / (h_sq * patch_area);
    let (wi, hi) = (w as isize, h as isize);
    let weight = |ssd: f64| -> f64 {
        // Match fast_neg_exp's range/sign clamps so the comparison isolates
        // summation accuracy, not the LUT's documented truncations.
        let x = ssd * inv_norm;
        if x < 0.0 {
            1.0
        } else if x >= 8.0 {
            0.0
        } else {
            (-x).exp()
        }
    };
    use rayon::prelude::*;
    let mut out = vec![0.0f32; w * h];
    out.par_iter_mut().enumerate().for_each(|(idx, dst)| {
        let x = (idx % w) as isize;
        let y = (idx / w) as isize;
        let mut acc = 0.0f64;
        let mut wsum = 0.0f64;
        let mut max_w = 0.0f64;
        for dy in -s..=s {
            for dx in -s..=s {
                if dx == 0 && dy == 0 {
                    continue;
                }
                // Both patches must fit.
                if x - p < 0
                    || x + p >= wi
                    || y - p < 0
                    || y + p >= hi
                    || x + dx - p < 0
                    || x + dx + p >= wi
                    || y + dy - p < 0
                    || y + dy + p >= hi
                {
                    continue;
                }
                let mut ssd = 0.0f64;
                for oy in -p..=p {
                    for ox in -p..=p {
                        let a = plane[((y + oy) * wi + (x + ox)) as usize] as f64;
                        let b = plane[((y + dy + oy) * wi + (x + dx + ox)) as usize] as f64;
                        let d = a - b;
                        ssd += d * d;
                    }
                }
                let wgt = weight(ssd);
                let sx = (x + dx) as usize;
                let sy = (y + dy) as usize;
                acc += wgt * plane[sy * w + sx] as f64;
                wsum += wgt;
                if wgt > max_w {
                    max_w = wgt;
                }
            }
        }
        let mw = max_w.max(1e-12);
        let total_w = wsum + mw;
        let total_acc = acc + mw * plane[idx] as f64;
        *dst = (total_acc / total_w) as f32;
    });
    let path = format!("{prefix}_{case}.f32");
    let bytes: Vec<u8> = out.iter().flat_map(|f| f.to_le_bytes()).collect();
    std::fs::write(&path, &bytes).expect("write truth dump");
    println!("truth   {case} ({w}x{h}) -> {path} ({} floats)", out.len());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("bench");

    // Plane sizes: 2 MP tick (1600x1250) and ~100 MP refine (11600x8700, the
    // reference Hasselblad frame's dimensions).
    let tick = (1600usize, 1250usize); // 2.0 MP
    let refine = (11600usize, 8700usize); // 100.9 MP

    match mode {
        "bench" => {
            let runs = args
                .get(2)
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(7);
            println!("# NLM denoise_plane timing — median of {runs} runs, --release");
            println!("# LUMA = P2/S2/h0.04 (24 shifts), CHROMA = P2/S3/h0.05 (48 shifts)");
            time_case("TICK luma  (2MP)", tick.0, tick.1, LUMA, runs);
            time_case("TICK chroma(2MP)", tick.0, tick.1, CHROMA, runs);
            // refine: fewer runs (each is ~1-2s)
            let refine_runs = runs.min(5);
            time_case(
                "REFINE luma  (100MP)",
                refine.0,
                refine.1,
                LUMA,
                refine_runs,
            );
            time_case(
                "REFINE chroma(100MP)",
                refine.0,
                refine.1,
                CHROMA,
                refine_runs,
            );
        }
        "dump" => {
            let prefix = args.get(2).map(String::as_str).unwrap_or("/tmp/nlm_ref");
            // Representative planes spanning small → large (large = the regime
            // where the integral image loses precision, per #1086).
            dump_case(prefix, "luma_257x193", 257, 193, LUMA);
            dump_case(prefix, "chroma_257x193", 257, 193, CHROMA);
            dump_case(prefix, "luma_1024x768", 1024, 768, LUMA);
            dump_case(prefix, "chroma_1024x768", 1024, 768, CHROMA);
            dump_case(prefix, "luma_2048x1536", 2048, 1536, LUMA);
            // a strip of a large plane to exercise far-from-origin offsets
            dump_case(prefix, "luma_4000x3000", 4000, 3000, LUMA);
            dump_case(prefix, "chroma_4000x3000", 4000, 3000, CHROMA);
        }
        "truth" => {
            // f64 ground truth for the same cases (skip the two largest — the
            // naive O(N·S²·P²) f64 pass is too slow there and the mid sizes
            // already expose the accumulation-accuracy trend).
            let prefix = args.get(2).map(String::as_str).unwrap_or("/tmp/nlm_truth");
            truth_case(prefix, "luma_257x193", 257, 193, LUMA);
            truth_case(prefix, "chroma_257x193", 257, 193, CHROMA);
            truth_case(prefix, "luma_1024x768", 1024, 768, LUMA);
            truth_case(prefix, "chroma_1024x768", 1024, 768, CHROMA);
            truth_case(prefix, "luma_2048x1536", 2048, 1536, LUMA);
            truth_case(prefix, "luma_4000x3000", 4000, 3000, LUMA);
            truth_case(prefix, "chroma_4000x3000", 4000, 3000, CHROMA);
        }
        other => {
            eprintln!("unknown mode {other:?}; use `bench` or `dump`");
            std::process::exit(2);
        }
    }
}
