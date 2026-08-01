//! Measurement harness for the #1089 item-8 tail: the three sub-items the
//! 2026-07-26 audit left flagged as UNKNOWN.
//!
//! The audit's instruction was to verify each claim in tree AND establish
//! whether it costs measurable time, so that anything fixed is fixed because
//! a number justified it rather than because the claim sounded plausible.
//! This example produces those numbers:
//!
//!   1. fp16 endcaps — measured through the real `apply_scene_linear_chain`
//!      under `MAPLE_PROFILE`, which is the pipeline's own per-stage
//!      instrumentation, so `ffi_chain_unpack_fp16` / `ffi_chain_pack_fp16`
//!      are timed exactly as they run for a live tick.
//!   2. `apply_orientation` — timed directly at the viewport and full-frame
//!      sizes, for the identity orientation and a transposing one, since the
//!      identity arm is a `to_vec` rather than a true no-op.
//!   3. The double Oklab round-trip when both NR sliders are active — timed
//!      as the chain's `ffi_chain_nr_luminance` + `ffi_chain_nr_color` pair,
//!      alongside a standalone round-trip so the redundant conversion's share
//!      of that pair is visible.
//!
//! Usage:
//!   MAPLE_PROFILE=1 cargo run --release -p raw-core --example tick-tail-bench

use raw_core::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use raw_core::image::{apply_orientation, ExifOrientation};
use raw_core::pipeline::{apply_scene_linear_chain, apply_scene_linear_chain_f32, ChainOptions};
use raw_core::types::AdjustmentModel;
use std::time::Instant;

/// 2 MP is the viewport buffer the live tick actually runs on (the chain
/// module's own docs use the same figure); 100 MP is the reference frame.
const VIEWPORT: (u32, u32) = (1728, 1152);
const FULL: (u32, u32) = (11656, 8742);

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn time<T>(runs: usize, mut f: impl FnMut() -> T) -> f64 {
    median(
        (0..runs)
            .map(|_| {
                let t = Instant::now();
                let r = f();
                let e = t.elapsed().as_secs_f64();
                std::hint::black_box(&r);
                e
            })
            .collect(),
    )
}

/// Deterministic scene-linear fp16 RGBA, with detail so nothing degenerates.
fn fp16_input(w: u32, h: u32) -> Vec<u16> {
    let n = (w as usize) * (h as usize);
    (0..n)
        .flat_map(|i| {
            let x = (i % w as usize) as f32;
            let y = (i / w as usize) as f32;
            let v = |k: f32| {
                let f = 0.18 * (1.0 + 0.4 * (k * 0.03).sin());
                // Inline f32 -> f16 via the same round-to-nearest-even rule
                // the pipeline uses; exactness does not matter for a timing
                // input, only that the bits are a valid finite half.
                half_bits(f)
            };
            [v(x), v(y), v(x + y), half_bits(1.0)]
        })
        .collect()
}

/// Minimal f32 -> f16 for building the timing input. Not the pipeline's
/// converter — this only has to produce valid finite halves.
fn half_bits(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mant = (bits >> 13) & 0x3ff;
    if exp <= 0 {
        sign
    } else {
        sign | ((exp as u16) << 10) | mant as u16
    }
}

/// FNV-1a over the raw bytes of a chain output. Printed so the endcap
/// parallelization can be checked byte-for-byte against `main`: build this
/// example on either side and compare the digests.
fn fnv1a_u16(buf: &[u16]) -> u64 {
    buf.iter()
        .flat_map(|v| v.to_le_bytes())
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
            (h ^ b as u64).wrapping_mul(0x1000_0000_01b3)
        })
}

fn oklab_roundtrip(px: &mut [[f32; 3]]) {
    for p in px.iter_mut() {
        *p = oklab_to_rec2020(rec2020_to_oklab(*p));
    }
}

fn main() {
    println!("threads (rayon): {}", rayon::current_num_threads());
    println!(
        "MAPLE_PROFILE  : {}\n",
        if std::env::var_os("MAPLE_PROFILE").is_some() {
            "on (per-stage lines go to stderr)"
        } else {
            "OFF — re-run with MAPLE_PROFILE=1 for the chain stage breakdown"
        }
    );

    // ---- Sub-item 2: apply_orientation ------------------------------------
    // Timed directly, because the identity arm is `rgb.to_vec()` — a full
    // buffer clone, not a free early-return — and the audit's claim turns on
    // whether that clone is measurable.
    println!("== apply_orientation (u8 RGB, the thumbnail/preview path) ==");
    for (label, (w, h)) in [("2MP ", VIEWPORT), ("100MP", FULL)] {
        let n = (w as usize) * (h as usize) * 3;
        let buf: Vec<u8> = (0..n).map(|i| (i % 251) as u8).collect();
        let t_id = time(5, || apply_orientation(&buf, w, h, ExifOrientation::Normal));
        let t_rot = time(5, || {
            apply_orientation(&buf, w, h, ExifOrientation::Rotate90)
        });
        println!(
            "  {label}  identity(to_vec) {:7.2} ms   Rotate90   {:7.2} ms   ({:.0} MB buffer)",
            t_id * 1e3,
            t_rot * 1e3,
            n as f64 / 1e6
        );
    }

    // ---- Sub-item 3: one Oklab round-trip ---------------------------------
    // The chain runs two of these when both NR sliders are on; this is what
    // the redundant one would cost if it were removed. Serial here on
    // purpose: the in-pipeline conversions are rayon-parallel, so this is the
    // upper bound on the redundant work, not the realised cost.
    println!("\n== Oklab round-trip, serial upper bound ==");
    for (label, (w, h)) in [("2MP ", VIEWPORT), ("100MP", FULL)] {
        let mut px = vec![[0.18f32, 0.17, 0.16]; (w as usize) * (h as usize)];
        let t = time(3, || oklab_roundtrip(&mut px));
        println!("  {label}  {:7.2} ms serial", t * 1e3);
    }

    // ---- Sub-items 1 + 3 in situ: the real chain --------------------------
    // With MAPLE_PROFILE set, this prints every stage of the live tick,
    // including `ffi_chain_unpack_fp16`, `ffi_chain_pack_fp16`,
    // `ffi_chain_nr_luminance` and `ffi_chain_nr_color`.
    let (w, h) = VIEWPORT;
    let input = fp16_input(w, h);

    println!("\n== apply_scene_linear_chain @ {w}x{h}, NR sliders OFF ==");
    let base = AdjustmentModel::default();
    let t_off = time(3, || {
        apply_scene_linear_chain(&input, w, h, &base, &ChainOptions::default())
            .expect("chain (NR off)")
    });
    println!(
        "  total {:7.2} ms   out-hash {:016x}",
        t_off * 1e3,
        fnv1a_u16(
            &apply_scene_linear_chain(&input, w, h, &base, &ChainOptions::default())
                .expect("chain (NR off)")
        )
    );

    println!("\n== apply_scene_linear_chain @ {w}x{h}, BOTH NR sliders ON ==");
    let nr = AdjustmentModel {
        nr_luminance: 50.0,
        nr_color: 50.0,
        ..AdjustmentModel::default()
    };
    let t_on = time(3, || {
        apply_scene_linear_chain(&input, w, h, &nr, &ChainOptions::default())
            .expect("chain (NR on)")
    });
    println!(
        "  total {:7.2} ms   (both-NR delta over baseline: {:+.2} ms)   out-hash {:016x}",
        t_on * 1e3,
        (t_on - t_off) * 1e3,
        fnv1a_u16(
            &apply_scene_linear_chain(&input, w, h, &nr, &ChainOptions::default())
                .expect("chain (NR on)")
        )
    );

    // The f32 sibling runs the identical stage list; only the endcaps differ
    // — four f32 lanes copied in and out, with no bit-level conversion. It is
    // the control for the fp16 endcap question: if `ffi_chain_pack_f32` moves
    // near DRAM speed while `ffi_chain_pack_fp16` moves ~1 GB/s on the same
    // buffer shape, the fp16 endcap's cost is the scalar converter, not the
    // memory system — and only the compute-bound one is worth threading.
    println!("\n== apply_scene_linear_chain_f32 @ {w}x{h} (endcap control) ==");
    let f32_input: Vec<f32> = (0..(w as usize) * (h as usize) * 4)
        .map(|i| if i % 4 == 3 { 1.0 } else { 0.18 })
        .collect();
    let t_f32 = time(3, || {
        apply_scene_linear_chain_f32(&f32_input, w, h, &base, &ChainOptions::default())
            .expect("f32 chain")
    });
    println!("  total {:7.2} ms", t_f32 * 1e3);

    // Endcap traffic at this size, for turning the per-stage millisecond
    // numbers above into achieved bandwidth by hand.
    let px = (w as usize) * (h as usize);
    println!(
        "\nendcap traffic @ {w}x{h}: fp16 unpack reads {:.1} MB / writes {:.1} MB; \
         fp16 pack reads {:.1} MB / writes {:.1} MB",
        (px * 4 * 2) as f64 / 1e6,
        (px * 12) as f64 / 1e6,
        (px * 12) as f64 / 1e6,
        (px * 4 * 2) as f64 / 1e6,
    );
}
