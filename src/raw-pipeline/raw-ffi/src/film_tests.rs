//! Tests for `maple_film_lut_decode` (epic #2683, Task 8). Pure byte-parsing
//! FFI — no fixtures, no worker thread, runs unconditionally.

use crate::error::maple_last_error;
use crate::film::maple_film_lut_decode;
use raw_core::film::encode_mlut;
use std::ffi::CStr;

/// An identity lattice: node (r,g,b) stores (r,g,b)/(n-1) — the same helper
/// pattern used throughout the film-look test family (`film.rs`,
/// `stages::film_look`, `pipeline::render::film_look_tests`).
fn identity_lattice(n: usize) -> Vec<f32> {
    let denom = (n - 1) as f32;
    let mut data = vec![0.0f32; n * n * n * 3];
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let i = ((b * n + g) * n + r) * 3;
                data[i] = r as f32 / denom;
                data[i + 1] = g as f32 / denom;
                data[i + 2] = b as f32 / denom;
            }
        }
    }
    data
}

/// Hand-craft a `.mlut` v1 byte buffer without going through
/// [`encode_mlut`] — `encode_mlut` now asserts `size >= 2` (by design: a
/// degenerate grid is a programmer error for the encoder), but this test
/// exists to exercise the *decoder's* rejection of a degenerate grid
/// arriving over the wire (untrusted bytes, not a programmer error). Layout
/// matches `raw_core::film`'s module doc: magic(4) + version(2) +
/// grid(2), little-endian, followed by `grid³·3` f16 payload values.
fn hand_craft_mlut(version: u16, grid: u16, payload_f16_values: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(8 + payload_f16_values * 2);
    bytes.extend_from_slice(b"MLUT");
    bytes.extend_from_slice(&version.to_le_bytes());
    bytes.extend_from_slice(&grid.to_le_bytes());
    bytes.extend(std::iter::repeat_n(0u8, payload_f16_values * 2));
    bytes
}

fn last_error_message() -> String {
    let ptr = unsafe { maple_last_error() };
    assert!(!ptr.is_null(), "expected an error message to be set");
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}

#[test]
fn decode_happy_path_round_trips_the_grid() {
    let n = 5usize;
    let data = identity_lattice(n);
    let bytes = encode_mlut(n, &data);
    let cap = n * n * n * 3;
    let mut out = vec![0.0f32; cap];

    let rc = unsafe { maple_film_lut_decode(bytes.as_ptr(), bytes.len(), out.as_mut_ptr(), cap) };

    assert_eq!(rc, n as i32, "rc should be the grid size N");
    // f16 storage is lossy but every k/(n-1) node in an identity lattice this
    // small round-trips within a tight tolerance (mirrors
    // `raw_core::film`'s own `mlut_round_trip_preserves_f16_exact_values`).
    for (got, want) in out.iter().zip(&data) {
        assert!(
            (got - want).abs() < 1e-3,
            "decoded value {got} vs source {want} exceeds the f16 round-trip tolerance"
        );
    }
}

#[test]
fn decode_happy_path_at_the_standard_33_cube_capacity() {
    // The brief's standard host allocation: 33 nodes/axis, `33*33*33*3 =
    // 107_811` floats. Exercised at the real catalog grid size, not just a
    // tiny synthetic one.
    let n = 33usize;
    let data = identity_lattice(n);
    let bytes = encode_mlut(n, &data);
    let cap = 33 * 33 * 33 * 3;
    assert_eq!(cap, 107_811);
    let mut out = vec![0.0f32; cap];

    let rc = unsafe { maple_film_lut_decode(bytes.as_ptr(), bytes.len(), out.as_mut_ptr(), cap) };

    assert_eq!(rc, 33);
}

#[test]
fn decode_rejects_malformed_bytes() {
    let n = 3usize;
    let data = identity_lattice(n);
    let good = encode_mlut(n, &data);
    let cap = n * n * n * 3;
    let mut out = vec![0.0f32; cap];

    // Bad magic (first byte flipped).
    let mut bad_magic = good.clone();
    bad_magic[0] ^= 0xFF;
    let rc = unsafe {
        maple_film_lut_decode(bad_magic.as_ptr(), bad_magic.len(), out.as_mut_ptr(), cap)
    };
    assert_eq!(rc, -1, "bad magic should return -1");
    assert!(last_error_message().contains("magic") || !last_error_message().is_empty());

    // Truncated payload.
    let truncated = &good[..good.len() - 2];
    let rc = unsafe {
        maple_film_lut_decode(truncated.as_ptr(), truncated.len(), out.as_mut_ptr(), cap)
    };
    assert_eq!(rc, -1, "truncated payload should return -1");

    // Degenerate grid (size 1) — hand-crafted since `encode_mlut` refuses
    // to build one (see `hand_craft_mlut`'s doc comment).
    let degenerate = hand_craft_mlut(1, 1, 3);
    let mut out1 = vec![0.0f32; 3];
    let rc = unsafe {
        maple_film_lut_decode(degenerate.as_ptr(), degenerate.len(), out1.as_mut_ptr(), 3)
    };
    assert_eq!(rc, -1, "degenerate grid should return -1");

    // `out` unmodified on the error path.
    assert!(
        out.iter().all(|&v| v == 0.0),
        "out must be untouched on error"
    );
}

#[test]
fn decode_rejects_undersized_output_capacity() {
    let n = 5usize;
    let data = identity_lattice(n);
    let bytes = encode_mlut(n, &data);
    let needed = n * n * n * 3;
    let mut out = vec![0.0f32; needed - 1]; // one float short

    let rc =
        unsafe { maple_film_lut_decode(bytes.as_ptr(), bytes.len(), out.as_mut_ptr(), needed - 1) };

    assert_eq!(rc, -2, "under-sized out_cap should return -2");
    assert!(out.iter().all(|&v| v == 0.0), "out must be untouched on -2");
    let msg = last_error_message();
    assert!(
        msg.contains(&needed.to_string()),
        "error message should mention the needed float count ({needed}): {msg}"
    );
}

#[test]
fn decode_rejects_null_pointers() {
    let mut out = [0.0f32; 8];
    assert_eq!(
        unsafe { maple_film_lut_decode(std::ptr::null(), 0, out.as_mut_ptr(), 8) },
        -1
    );
    let bytes = encode_mlut(2, &identity_lattice(2));
    assert_eq!(
        unsafe { maple_film_lut_decode(bytes.as_ptr(), bytes.len(), std::ptr::null_mut(), 8) },
        -1
    );
}
