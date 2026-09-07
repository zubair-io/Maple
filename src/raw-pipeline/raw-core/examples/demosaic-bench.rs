//! Decode-time comparison of the Bayer demosaic kernels (#3412, #3413).
//!
//! Two acceptance criteria are wall-clock ones — "RCD decode on the 100 MP
//! reference is at least 2× faster than AMaZE on M-series" (#3412) and
//! "export time on the 100 MP reference stays within 1.5× AMaZE" (#3413) —
//! so this is the harness that produces both numbers, alongside the
//! bilinear floor the on-screen `RenderQuality::Full` path used to run.
//!
//! Only the demosaic is timed: decode and `sensor_linearize` run once, up
//! front, outside the timed region, so the figures are the kernel's own cost
//! rather than a whole cold open's.
//!
//! Two statistics are reported per kernel. The **median** is what #3412's
//! committed table quotes and is the right number on a machine doing
//! nothing else. The **best** run is the robust one when the machine is
//! shared: contention can only ever make a run slower, so the fastest of N
//! is the closest estimate of the uncontended cost, and it is the basis for
//! the ratios in the summary. On a quiet machine the two agree closely; a
//! wide gap between them is itself the signal that the numbers were taken
//! under load and should be re-measured before being quoted.
//!
//! Each kernel's output is hashed, so a timing claim always arrives with
//! evidence that the three kernels actually produced different images (a
//! silently-misdispatched run would otherwise read as a free speedup), and
//! the mean absolute per-channel distance from bilinear is reported as a
//! coarse "how far did it move the pixels" figure.
//!
//! Usage:
//!   cargo run --release -p raw-core --example demosaic-bench -- <RAW> [runs]
//!
//! Defaults to `test-fixtures/raws/dji-mavic3pro-100mp.dng` and 3 runs.

use raw_core::demosaic::{
    amaze, bilinear, dual_amaze_vng4, dual_rcd_vng4, hamilton_adams, lmmse, rcd, vng4,
};
use raw_core::image::Image;
use std::time::Instant;

/// FNV-1a over the raw bytes of the pixel buffer — byte-level, so even a
/// `-0.0` vs `0.0` difference shows.
fn fnv1a(buf: &[[f32; 3]]) -> u64 {
    let bytes = unsafe {
        std::slice::from_raw_parts(buf.as_ptr() as *const u8, std::mem::size_of_val(buf))
    };
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| {
        (h ^ b as u64).wrapping_mul(0x1000_0000_01b3)
    })
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn best(v: &[f64]) -> f64 {
    v.iter().copied().fold(f64::INFINITY, f64::min)
}

/// Mean absolute per-channel difference between two reconstructions.
fn mean_abs_diff(a: &Image, b: &Image) -> f64 {
    let total: f64 = a
        .pixels
        .iter()
        .zip(&b.pixels)
        .map(|(p, q)| ((p[0] - q[0]).abs() + (p[1] - q[1]).abs() + (p[2] - q[2]).abs()) as f64)
        .sum();
    total / (a.pixels.len() as f64 * 3.0)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .unwrap_or_else(|| "test-fixtures/raws/dji-mavic3pro-100mp.dng".to_string());
    let runs: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(3);

    let raw = match raw_core::decode::decode(std::path::Path::new(&path)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("cannot decode {path}: {e}");
            std::process::exit(1);
        }
    };
    let mosaic = raw_core::linearize::sensor_linearize(&raw);
    let mp = (mosaic.width as f64 * mosaic.height as f64) / 1e6;

    println!("fixture       : {path}");
    println!(
        "sensor        : {}x{} ({mp:.1} MP), CFA {:?}",
        mosaic.width, mosaic.height, raw.cfa
    );
    println!("threads (rayon): {}", rayon::current_num_threads());
    println!("runs per kernel: {runs}\n");

    let kernels: [(&str, fn(&Image, raw_core::image::CfaPattern) -> Image); 8] = [
        ("bilinear      ", bilinear),
        ("hamilton-adams", hamilton_adams),
        ("vng4          ", vng4),
        ("rcd           ", rcd),
        ("lmmse         ", lmmse),
        ("amaze         ", amaze),
        ("dual-rcd-vng4 ", dual_rcd_vng4),
        ("dual-amaze-vng4", dual_amaze_vng4),
    ];

    let reference = bilinear(&mosaic, raw.cfa);
    let mut baseline_ms = 0.0f64;
    let mut amaze_ms = 0.0f64;
    let mut rcd_ms = 0.0f64;
    let mut dual_amaze_ms = 0.0f64;

    // Round-robin, not kernel-by-kernel: one run of every kernel, `runs`
    // times over. Timing eight kernels back to back means a load spike lands
    // entirely inside one kernel's block and silently taxes that kernel
    // alone — which is how an earlier measurement of this set produced a
    // dual mode "cheaper" than the kernel it wraps. Interleaving spreads any
    // slow-varying interference across all of them, so the per-kernel best
    // runs are drawn from comparable conditions and the ratios below mean
    // something even on a shared machine.
    let mut all_times: Vec<Vec<f64>> = vec![Vec::with_capacity(runs); kernels.len()];
    for _ in 0..runs {
        for (k, (_, kernel)) in kernels.iter().enumerate() {
            let t = Instant::now();
            let out = kernel(&mosaic, raw.cfa);
            let e = t.elapsed().as_secs_f64();
            std::hint::black_box(&out.pixels);
            all_times[k].push(e);
        }
    }

    for (k, (name, kernel)) in kernels.into_iter().enumerate() {
        let times = std::mem::take(&mut all_times[k]);
        let ms = median(times.clone()) * 1e3;
        let best_ms = best(&times) * 1e3;
        let out = kernel(&mosaic, raw.cfa);
        println!(
            "{name}: median {ms:9.1} ms   best {best_ms:9.1} ms   {:6.1} Mpx/s   \
             hash {:016x}   mean|Δ vs bilinear| {:.6}",
            mp / (best_ms / 1e3),
            fnv1a(&out.pixels),
            mean_abs_diff(&out, &reference)
        );
        match name.trim() {
            "bilinear" => baseline_ms = best_ms,
            "rcd" => rcd_ms = best_ms,
            "amaze" => amaze_ms = best_ms,
            "dual-amaze-vng4" => dual_amaze_ms = best_ms,
            _ => {}
        }
    }

    // Ratios from the best run of each kernel — see the module docs.
    println!(
        "\nrcd vs bilinear      : {:.2}x slower\nrcd vs amaze         : {:.2}x faster\n\
         dual-amaze vs amaze  : {:.2}x cost (#3413 budget: 1.50x)",
        rcd_ms / baseline_ms,
        amaze_ms / rcd_ms,
        dual_amaze_ms / amaze_ms
    );
}
