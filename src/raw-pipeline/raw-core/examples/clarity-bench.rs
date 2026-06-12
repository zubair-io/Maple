//! Allocation + timing harness for the clarity / texture stages (#1089 item 7).
//!
//! Not a CI gate — a one-shot measurement tool. Wraps the process in a counting
//! global allocator so it can report *exactly* how many heap allocations a
//! single `clarity::apply` (or `texture::apply`) call makes, alongside a median
//! wall-time over several runs.
//!
//! Usage:
//!   cargo run --release -p raw-core --example clarity-bench -- <stage> <megapixels> [runs]
//!     stage       : clarity | texture
//!     megapixels  : e.g. 2 (the tick target) or 24 (a large plane)
//!     runs        : timed iterations (median reported); default 9
//!
//! The allocation count is measured on a SINGLE call (counters reset
//! immediately before it) so the number is the per-tick allocation count, not a
//! per-run-loop sum. Timing is the median of `runs` calls on a freshly-cloned
//! input each time (clone cost excluded from the timed region).

use raw_core::image::{ColorSpace, Image};
use raw_core::stages::{clarity, texture};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

/// Counting allocator: forwards to the system allocator and tallies every
/// allocation call plus the total bytes requested. Relaxed ordering is fine —
/// we read the counters only at quiescent points (between calls), and the
/// blur passes are the only concurrent allocators of interest.
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
        // A realloc that grows is, for our purposes, another allocation event
        // and `new_size - old_size` more bytes of churn. Vec growth from an
        // empty/under-sized buffer shows up here.
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(new_size.saturating_sub(layout.size()), Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

/// Build a representative scene-linear Rec.2020 plane with real high-frequency
/// content (so the guided filter's edge-aware path is actually exercised and
/// nothing short-circuits to a flat-field trivial case). Deterministic.
fn make_input(mp: f64) -> Image {
    // Pick w:h ≈ 3:2 for the requested megapixel count.
    let total = (mp * 1_000_000.0) as usize;
    let h = ((total as f64 / 1.5).sqrt()).round() as u32;
    let w = ((h as f64) * 1.5).round() as u32;
    let mut img = Image::new(w.max(1), h.max(1), ColorSpace::SceneLinearRec2020);
    let wf = w as f32;
    let hf = h as f32;
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let x = (i as u32 % w) as f32;
        let y = (i as u32 / w) as f32;
        // A couple of sinusoids at different scales + a hard diagonal edge:
        // gives the guided filter genuine structure to follow.
        let lo = 0.5 + 0.35 * (x / wf * 11.0).sin() * (y / hf * 7.0).cos();
        let hi = 0.08 * (x * 0.37).sin() * (y * 0.41).cos();
        let edge = if x + y > (wf + hf) * 0.5 { 0.12 } else { -0.12 };
        let base = (lo + hi + edge).max(0.0);
        // Mild chroma so R:G:B differ (clarity is luma-only; the ratios must
        // survive — irrelevant to timing/alloc but keeps the input honest).
        *p = [base * 1.03, base, base * 0.97];
    }
    img
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
    let stage = args.get(1).map(|s| s.as_str()).unwrap_or("clarity");
    let mp: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let runs: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(9);
    let amount = 50.0_f32; // "clarity ON, e.g. +50"

    let apply: fn(&mut Image, f32) = match stage {
        "texture" => texture::apply,
        _ => clarity::apply,
    };

    let base = make_input(mp);
    let px = base.pixels.len();

    // --- Allocation count on a single call ---
    // Clone first (clone allocations happen before the reset), then reset the
    // counters and run exactly one apply. The delta is the per-call count.
    let mut one = base.clone();
    ALLOC_COUNT.store(0, Ordering::Relaxed);
    ALLOC_BYTES.store(0, Ordering::Relaxed);
    apply(&mut one, amount);
    let alloc_count = ALLOC_COUNT.load(Ordering::Relaxed);
    let alloc_bytes = ALLOC_BYTES.load(Ordering::Relaxed);
    // Keep `one` alive past the measurement so its drop doesn't race the read.
    std::hint::black_box(&one);

    // --- Timing: median over `runs`, fresh clone each iteration ---
    // Warm up once (allocator caches, rayon thread-pool spin-up).
    {
        let mut warm = base.clone();
        apply(&mut warm, amount);
        std::hint::black_box(&warm);
    }
    let mut times_ms = Vec::with_capacity(runs);
    for _ in 0..runs {
        let mut scratch = base.clone();
        let t0 = Instant::now();
        apply(&mut scratch, amount);
        let dt = t0.elapsed();
        std::hint::black_box(&scratch);
        times_ms.push(dt.as_secs_f64() * 1000.0);
    }
    let med = median(times_ms.clone());
    let min = times_ms.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = times_ms.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    // FNV-1a over the raw output bytes — a byte-identity fingerprint so the
    // arena rewrite can be proven bit-identical to the pre-rewrite output for
    // this exact input. Hash the same `one` buffer the alloc count came from.
    let hash = fnv1a_pixels(&one.pixels);

    println!(
        "stage={stage} mp={mp:.1} px={px} w={} h={} amount={amount} runs={runs}",
        base.width, base.height
    );
    println!(
        "alloc_count={alloc_count} alloc_bytes={alloc_bytes} ({:.1} MB)",
        alloc_bytes as f64 / (1024.0 * 1024.0)
    );
    println!("median_ms={med:.3} min_ms={min:.3} max_ms={max:.3}");
    println!("output_fnv1a=0x{hash:016x}");
}

/// FNV-1a 64-bit over the little-endian bytes of every f32 channel. Bit-exact
/// fingerprint of the output — any change in rounding flips it.
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
