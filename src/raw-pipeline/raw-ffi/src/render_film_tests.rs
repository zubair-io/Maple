//! Tests for `maple_render_file_with_film` (epic #2683, Task 8) — the
//! film-look sibling of `maple_render_file`. Uses `SyntheticGreyDng` (no
//! on-disk fixture required), matching `raw_core::pipeline::render::
//! film_look_tests`'s in-memory approach so these run unconditionally.

use crate::buffers::{maple_free_buffer, MapleImageBuffer};
use crate::render::maple_render_file;
use crate::render_film::maple_render_file_with_film;
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use std::ffi::CString;

fn empty_buffer() -> MapleImageBuffer {
    MapleImageBuffer {
        rgb: std::ptr::null_mut(),
        len: 0,
        width: 0,
        height: 0,
    }
}

/// Identity lattice: node (r,g,b) stores (r,g,b)/(n-1) — reproduces its
/// input, so blending toward it at full strength should reproduce the
/// no-look render within a tight tolerance (mirrors the raw-core-level
/// `film_lut_identity_lattice_at_full_strength_matches_no_lut_within_mean_delta`).
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

fn write_synthetic_raw(dir: &tempfile::TempDir) -> CString {
    let path = dir.path().join("synthetic_grey.dng");
    SyntheticGreyDng::default()
        .write_to(&path)
        .expect("write synthetic DNG");
    CString::new(path.to_str().unwrap()).unwrap()
}

/// `film_lut_ptr: null` must render byte-identical to `maple_render_file` —
/// the same missing-asset -> identity rule `render_from_raw_with_quality_
/// source_and_film`'s `film_lut: None` contract guarantees at the raw-core
/// level, now proven across the FFI boundary too.
#[test]
fn null_film_lut_matches_maple_render_file() {
    let dir = tempfile::tempdir().unwrap();
    let raw_cstr = write_synthetic_raw(&dir);

    let mut plain = empty_buffer();
    let rc = unsafe { maple_render_file(raw_cstr.as_ptr(), std::ptr::null(), 0, &mut plain) };
    assert_eq!(rc, 0, "maple_render_file rc = {rc}");

    let mut with_film = empty_buffer();
    let rc = unsafe {
        maple_render_file_with_film(
            raw_cstr.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            0,
            0,
            &mut with_film,
        )
    };
    assert_eq!(rc, 0, "maple_render_file_with_film rc = {rc}");

    assert_eq!(plain.width, with_film.width);
    assert_eq!(plain.height, with_film.height);
    assert_eq!(plain.len, with_film.len);
    let plain_bytes = unsafe { std::slice::from_raw_parts(plain.rgb, plain.len) };
    let film_bytes = unsafe { std::slice::from_raw_parts(with_film.rgb, with_film.len) };
    assert_eq!(
        plain_bytes, film_bytes,
        "null film_lut_ptr must be byte-identical to maple_render_file"
    );

    unsafe {
        maple_free_buffer(&mut plain);
        maple_free_buffer(&mut with_film);
    }
}

/// An identity lattice at full strength must reproduce the no-look render
/// within a tight per-channel tolerance — proves the FFI actually threads
/// the grid through to `film_look::apply`, not just that a null pointer is a
/// no-op.
#[test]
fn identity_lattice_at_full_strength_matches_no_lut_within_tolerance() {
    let dir = tempfile::tempdir().unwrap();
    let raw_cstr = write_synthetic_raw(&dir);
    let n = 17usize;
    let lattice = identity_lattice(n);

    let mut plain = empty_buffer();
    assert_eq!(
        unsafe { maple_render_file(raw_cstr.as_ptr(), std::ptr::null(), 0, &mut plain) },
        0
    );

    let mut with_film = empty_buffer();
    let rc = unsafe {
        maple_render_file_with_film(
            raw_cstr.as_ptr(),
            std::ptr::null(),
            0,
            lattice.as_ptr(),
            lattice.len(),
            n as u32,
            &mut with_film,
        )
    };
    assert_eq!(rc, 0, "maple_render_file_with_film rc = {rc}");
    assert_eq!(plain.len, with_film.len);

    let plain_bytes = unsafe { std::slice::from_raw_parts(plain.rgb, plain.len) };
    let film_bytes = unsafe { std::slice::from_raw_parts(with_film.rgb, with_film.len) };
    let max_delta = plain_bytes
        .iter()
        .zip(film_bytes)
        .map(|(a, b)| (*a as i16 - *b as i16).unsigned_abs())
        .max()
        .unwrap_or(0);
    assert!(
        max_delta <= 1,
        "identity lattice at full strength: max byte delta {max_delta} > 1 vs the no-look render"
    );
    // Note: `AdjustmentModel::default()` (no XMP supplied) carries
    // `film_strength: 100.0` — so with no null-strength short-circuit in the
    // way, this genuinely exercises the grid marshalling through
    // `film_look::apply` at full blend, not just a no-op path.

    unsafe {
        maple_free_buffer(&mut plain);
        maple_free_buffer(&mut with_film);
    }
}

/// A `film_lut_len` that doesn't match `film_lut_size³·3` must render
/// WITHOUT the look (byte-identical to the null case) rather than erroring
/// or reading past the caller's slice.
#[test]
fn mismatched_lut_len_renders_without_the_look() {
    let dir = tempfile::tempdir().unwrap();
    let raw_cstr = write_synthetic_raw(&dir);
    let n = 5usize;
    let mut lattice = identity_lattice(n);
    lattice.pop(); // now one float short of n³·3

    let mut plain = empty_buffer();
    assert_eq!(
        unsafe { maple_render_file(raw_cstr.as_ptr(), std::ptr::null(), 0, &mut plain) },
        0
    );

    let mut with_film = empty_buffer();
    let rc = unsafe {
        maple_render_file_with_film(
            raw_cstr.as_ptr(),
            std::ptr::null(),
            0,
            lattice.as_ptr(),
            lattice.len(),
            n as u32,
            &mut with_film,
        )
    };
    assert_eq!(rc, 0, "a mismatched grid must not error the render");

    let plain_bytes = unsafe { std::slice::from_raw_parts(plain.rgb, plain.len) };
    let film_bytes = unsafe { std::slice::from_raw_parts(with_film.rgb, with_film.len) };
    assert_eq!(
        plain_bytes, film_bytes,
        "a mismatched grid must render identically to no-look, not read past the slice"
    );

    unsafe {
        maple_free_buffer(&mut plain);
        maple_free_buffer(&mut with_film);
    }
}
