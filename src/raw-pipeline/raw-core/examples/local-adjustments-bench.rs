//! Allocation + timing harness for the `local_adjustments` stage (#1698).
//!
//! Not a CI gate — a one-shot measurement tool, built on the same shape as
//! `clarity-bench`. It reports how many heap allocations a single
//! `local_adjustments::apply` call makes (the stage must allocate nothing
//! inside the render loop) alongside a median wall time, plus an FNV-1a
//! fingerprint of the output buffer so a refactor can be proven
//! bit-identical to the version before it.
//!
//! Usage:
//!   cargo run --release -p raw-core --example local-adjustments-bench -- <layers> <megapixels> [runs]
//!     layers      : number of stacked local-adjustment layers; default 1
//!     megapixels  : e.g. 2 (a preview) or 100 (the reference RAW); default 100
//!     runs        : timed iterations, median reported; default 9
//!
//! Layer 0 is a feathered linear gradient carrying every one of the nine
//! wired controls, so the timed path exercises the whole `apply_pixel` body
//! (including the per-pixel CAT16 derivation and the Oklab
//! saturation/vibrance round trips). Additional layers alternate with a
//! feathered radial so the multi-layer cost is representative.

use raw_core::image::{ColorSpace, Image};
use raw_core::stages::local_adjustments;
use raw_core::types::{LocalAdjustment, Mask, PartialAdjustments, Point2};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

/// Counting allocator: forwards to the system allocator and tallies every
/// allocation call plus the total bytes requested. Relaxed ordering is fine —
/// the counters are only read at quiescent points (between calls).
struct CountingAlloc;

static ALLOC_COUNT: AtomicUsize = AtomicUsize::new(0);
static ALLOC_BYTES: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(new_size.saturating_sub(layout.size()), Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

/// A scene-linear Rec.2020 plane with real structure across the tonal range,
/// so the luma-coupled controls (highlights / shadows / whites / blacks) and
/// the Oklab gamut bisection are all genuinely exercised. Deterministic.
fn make_input(mp: f64) -> Image {
    let total = (mp * 1_000_000.0) as usize;
    let h = ((total as f64 / 1.5).sqrt()).round() as u32;
    let w = ((h as f64) * 1.5).round() as u32;
    let mut img = Image::new(w.max(1), h.max(1), ColorSpace::SceneLinearRec2020);
    let wf = w as f32;
    let hf = h as f32;
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let x = (i as u32 % w) as f32;
        let y = (i as u32 / w) as f32;
        // A wide luminance ramp (0 → ~3.5, i.e. well past the Y=1 knee) plus
        // high-frequency detail, so highlights/shadows/whites/blacks all see
        // pixels inside their engagement bands.
        let ramp = 3.5 * (x / wf) * (0.25 + 0.75 * (y / hf));
        let detail = 0.15 * (x * 0.37).sin() * (y * 0.41).cos();
        let base = (ramp + detail).max(0.0);
        // Real chroma so the Oklab paths don't take the near-neutral guard.
        *p = [base * 1.18, base, base * 0.74];
    }
    img
}

/// Layer 0 carries every wired control; later layers alternate radial/linear.
fn make_layers(n: usize) -> Vec<LocalAdjustment> {
    let full = PartialAdjustments {
        exposure: Some(0.6),
        contrast: Some(25.0),
        highlights: Some(-40.0),
        shadows: Some(30.0),
        whites: Some(15.0),
        blacks: Some(-20.0),
        saturation: Some(35.0),
        vibrance: Some(25.0),
        temperature: Some(1200.0),
        tint: Some(8.0),
    };
    (0..n)
        .map(|i| {
            if i % 2 == 0 {
                LocalAdjustment {
                    mask: Mask::Linear {
                        start: Point2::new(0.1, 0.15),
                        end: Point2::new(0.9, 0.85),
                        feather: 0.6,
                    },
                    adjustments: full.clone(),
                }
            } else {
                LocalAdjustment {
                    mask: Mask::Radial {
                        center: Point2::new(0.45, 0.55),
                        radii: Point2::new(0.35, 0.28),
                        angle: 0.4,
                        feather: 0.5,
                        invert: false,
                    },
                    adjustments: full.clone(),
                }
            }
        })
        .collect()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let layer_count: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
    let mp: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(100.0);
    let runs: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(9);

    let base = make_input(mp);
    let layers = make_layers(layer_count);
    let px = base.pixels.len();

    // --- Warm up FIRST (allocator caches + rayon's one-time global
    //     thread-pool spin-up, which is process-lifetime, not per call), so
    //     the allocation count below is the STEADY-STATE per-call number the
    //     "no allocation inside the render loop" invariant is about. ---
    {
        let mut warm = base.clone();
        local_adjustments::apply(&mut warm, &layers);
        std::hint::black_box(&warm);
    }

    // --- Allocation count on a single call ---
    let mut one = base.clone();
    ALLOC_COUNT.store(0, Ordering::Relaxed);
    ALLOC_BYTES.store(0, Ordering::Relaxed);
    local_adjustments::apply(&mut one, &layers);
    let alloc_count = ALLOC_COUNT.load(Ordering::Relaxed);
    let alloc_bytes = ALLOC_BYTES.load(Ordering::Relaxed);
    std::hint::black_box(&one);

    // --- Timing: median over `runs`, fresh clone each iteration ---
    let mut times_ms = Vec::with_capacity(runs);
    for _ in 0..runs {
        let mut scratch = base.clone();
        let t0 = Instant::now();
        local_adjustments::apply(&mut scratch, &layers);
        let dt = t0.elapsed();
        std::hint::black_box(&scratch);
        times_ms.push(dt.as_secs_f64() * 1000.0);
    }
    let med = median(times_ms.clone());
    let min = times_ms.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = times_ms.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    let hash = fnv1a_pixels(&one.pixels);

    println!(
        "layers={layer_count} mp={mp:.1} px={px} w={} h={} runs={runs}",
        base.width, base.height
    );
    println!(
        "alloc_count={alloc_count} alloc_bytes={alloc_bytes} ({:.1} MB)",
        alloc_bytes as f64 / (1024.0 * 1024.0)
    );
    println!("median_ms={med:.3} min_ms={min:.3} max_ms={max:.3}");
    println!("output_fnv1a=0x{hash:016x}");
}

/// FNV-1a 64-bit over the little-endian bytes of every f32 channel — a
/// bit-exact fingerprint of the output. Any change in rounding flips it.
fn fnv1a_pixels(pixels: &[[f32; 3]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in pixels {
        for c in p {
            for b in c.to_bits().to_le_bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
    }
    h
}
