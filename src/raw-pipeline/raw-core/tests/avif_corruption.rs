#![cfg(feature = "avif")]
//! Single-byte corruption sweep over a tiny AVIF (#3517).
//!
//! The contract under test is deliberately weak: for *every* one-byte
//! corruption of a valid AVIF, the decoder and the metadata probe must
//! **return** — `Ok` or `Err`, either is fine. What they must not do is take
//! the process with them.
//!
//! That is not a theoretical worry. Before #3517 this sweep killed the whole
//! test binary with SIGABRT (exit 134), twice over:
//!
//!   * rav1d unwraps a `None` in tile decoding on a truncated OBU, and its
//!     `dav1d_*` entry points were plain `extern "C"` — a frame Rust may not
//!     unwind out of, so the panic became an immediate `abort()` rather than
//!     something a caller could catch.
//!   * `avif-parse` asserts on its own parser state when a box length no
//!     longer matches the bytes behind it.
//!
//! In production the first one killed the API's FFI child process before
//! raw-ffi's `catch_panic_rc` barrier could turn it into an error return —
//! which is why "returns at all" is the property worth pinning here.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

/// A 16x16 solid-colour AVIF: the shape of the thumbnails the pipeline itself
/// writes, and small enough (~288 bytes) to sweep exhaustively.
fn tiny_avif() -> Vec<u8> {
    let rgb: Vec<u8> = (0..16 * 16).flat_map(|_| [180u8, 70, 40]).collect();
    raw_core::avif::encode(16, 16, &rgb, 80).expect("encode a 16x16 AVIF")
}

/// Hundreds of these corruptions panic somewhere inside rav1d or avif-parse,
/// and the default hook prints every one, burying the tallies that are the
/// actual signal. Drop those, but keep panics raised from this file — the
/// assertions below are useless if their own messages are swallowed too.
fn quieten_provoked_panics() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if info.location().is_some_and(|at| at.file() == file!()) {
                default(info);
            }
        }));
    });
}

/// Tally of how each corruption came back, so a run says what it exercised
/// rather than only that it survived.
#[derive(Default)]
struct Tally {
    decoded: usize,
    rejected: usize,
    rav1d_panics: usize,
    container_panics: usize,
}

impl Tally {
    fn record(&mut self, outcome: Result<(), String>) {
        match outcome {
            Ok(()) => self.decoded += 1,
            Err(reason) if reason.contains("panicked inside rav1d") => self.rav1d_panics += 1,
            Err(reason) if reason.contains("container parse panicked") => {
                self.container_panics += 1
            }
            Err(_) => self.rejected += 1,
        }
    }

    fn total(&self) -> usize {
        self.decoded + self.rejected + self.rav1d_panics + self.container_panics
    }
}

impl std::fmt::Display for Tally {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} cases: {} decoded, {} rejected, {} rav1d panics caught, \
             {} container panics caught",
            self.total(),
            self.decoded,
            self.rejected,
            self.rav1d_panics,
            self.container_panics
        )
    }
}

/// Runs `call` on every single-byte corruption of a valid AVIF — each offset
/// against three replacement values (all bits clear, all bits set, and the top
/// bit flipped, which perturbs a byte without landing on a common sentinel) —
/// and fails, naming the offending byte, the moment anything escapes as a
/// panic instead of a return value.
fn sweep(label: &str, call: impl Fn(&[u8]) -> Result<(), String>) -> Tally {
    quieten_provoked_panics();
    let base = tiny_avif();
    let mut tally = Tally::default();
    let mut escaped = None;
    'sweep: for (off, &orig) in base.iter().enumerate() {
        for repl in [0x00u8, 0xFF, orig ^ 0x80] {
            if repl == orig {
                continue;
            }
            let mut bytes = base.clone();
            bytes[off] = repl;
            match catch_unwind(AssertUnwindSafe(|| call(&bytes))) {
                Ok(outcome) => tally.record(outcome),
                Err(_) => {
                    escaped = Some((off, repl));
                    break 'sweep;
                }
            }
        }
    }
    eprintln!("{label}: {tally}");
    if let Some((off, repl)) = escaped {
        panic!(
            "{label} unwound out to its caller on byte {off} (of {}) set to 0x{repl:02X} \
             — a corrupt AVIF must come back as Ok or Err, never as an unwind",
            base.len()
        );
    }
    assert!(
        tally.total() >= 2 * base.len(),
        "sweep covered only {} of ~{} corruptions",
        tally.total(),
        3 * base.len()
    );
    tally
}

#[test]
fn every_single_byte_corruption_returns_from_decode() {
    let tally = sweep("decode_avif", |bytes| {
        raw_core::avif_decode::decode_avif(bytes)
            .map(|_| ())
            .map_err(|e| e.to_string())
    });

    // The sweep passing is the regression guard; this is the proof it still
    // reaches the barrier it was written for. If a future rav1d stops
    // panicking on every one of these streams, that is good news and this
    // assertion is what will say so — relax it then, do not delete the sweep.
    assert!(
        tally.rav1d_panics > 0,
        "no corruption reached rav1d's panicking path, so this sweep no longer \
         exercises the #3517 barrier: {tally}"
    );
}

#[test]
fn every_single_byte_corruption_returns_from_the_probe() {
    // `is_avif` only sniffs the `ftyp` brand, so it must answer for every
    // corruption too — including ones that hit the brand itself.
    let tally = sweep("probe_avif", |bytes| {
        if !raw_core::avif_decode::is_avif(bytes) {
            return Err("not avif".into());
        }
        raw_core::avif_decode::probe_avif(bytes)
            .map(|_| ())
            .map_err(|e| e.to_string())
    });
    // Same rationale as the decode sweep: proof the probe path really does
    // run into a panicking parser, so the barrier in front of it is load-bearing
    // rather than decorative.
    assert!(
        tally.container_panics > 0,
        "no corruption reached avif-parse's asserting path, so this sweep no longer \
         exercises the container barrier: {tally}"
    );
}
