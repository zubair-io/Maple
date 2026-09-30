//! `.mlut` film-look LUT decode FFI (epic #2683, Task 8) — the Apple-facing
//! boundary that turns a raw `.mlut` byte buffer (`raw_core::film::decode_mlut`,
//! Task 1) into the flat `size³·3` f32 lattice the Swift host caches and later
//! feeds to [`crate::MapleGpuLiveParams`]'s `film_lut_*` tail or to
//! `maple_render_file_with_film`.
//!
//! The rc protocol mirrors `maple_gpu_fit_auto_profile`'s grow-and-retry
//! contract: the host doesn't know the grid size up front, so it allocates a
//! conservative `out_cap` (the catalog's baked grid is fixed at 33 nodes/axis
//! — `33*33*33*3 = 107_811` floats — so that is the standard one-shot
//! allocation) and re-calls with a bigger buffer only on the rare `-2`.

use crate::error::set_last_error;
use raw_core::film::decode_mlut;

/// Owned, immutable LUT for repeated CPU preview ticks (#3877).
/// Hosts release it only after every borrowing render call has returned.
pub struct MapleFilmLut {
    pub(crate) lut: raw_core::film::FilmLut,
}

/// Copy a validated lattice once, outside the render loop. Returns null on error.
/// # Safety
/// `data` must be readable for `len` aligned floats for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn maple_film_lut_create(
    size: u32,
    data: *const f32,
    len: usize,
) -> *mut MapleFilmLut {
    let expected = (size as usize)
        .checked_pow(3)
        .and_then(|n| n.checked_mul(3));
    if !(2..=129).contains(&size)
        || expected != Some(len)
        || data.is_null()
        || (data as usize) % std::mem::align_of::<f32>() != 0
    {
        set_last_error("film_lut_create: invalid lattice shape or pointer".into());
        return std::ptr::null_mut();
    }
    let values = std::slice::from_raw_parts(data, len);
    if values.iter().any(|value| !value.is_finite()) {
        set_last_error("film_lut_create: non-finite lattice".into());
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(MapleFilmLut {
        lut: raw_core::film::FilmLut {
            size: size as usize,
            data: values.to_vec(),
        },
    }))
}

/// # Safety
/// `handle` must be null or an unreleased result of `maple_film_lut_create`.
/// No other call may borrow the handle while it is released.
#[no_mangle]
pub unsafe extern "C" fn maple_film_lut_destroy(handle: *mut MapleFilmLut) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// Decode a `.mlut` v1 byte buffer into a flat `size³·3` f32 RGB lattice
/// (layout `((b*N+g)*N+r)*3+c` — [`raw_core::film::FilmLut`]'s layout,
/// matched by [`raw_core::film::tetra_sample`] and its WGSL twin), written
/// into the caller-owned `out`.
///
/// Returns:
/// - The grid size `N` (always `> 0` — [`decode_mlut`] rejects degenerate
///   grids below 2×2×2) on success, with `out[0..N³·3]` written.
/// - `-1` on a malformed buffer (bad magic, unsupported version, truncated,
///   or a degenerate grid — see `raw_core::film::MlutError`; `maple_last_error`
///   is set) OR a null/misaligned pointer argument (`maple_last_error` not set
///   for the null-pointer case — the caller has both pointers in hand).
/// - `-2` when `out_cap` is smaller than the decoded grid needs (`N³·3`
///   floats). `maple_last_error` is set with the required size; re-call with
///   a larger `out` — decoding is cheap (pure byte parsing), so re-decoding
///   the same `bytes` on retry costs nothing material.
///
/// `out` is untouched on any error path.
///
/// # Safety
/// `bytes` must be valid for `len` byte reads. `out` must be a valid,
/// f32-aligned pointer to at least `out_cap` writable `f32`s for the duration
/// of the call, or null (rejected before any write).
#[no_mangle]
pub unsafe extern "C" fn maple_film_lut_decode(
    bytes: *const u8,
    len: usize,
    out: *mut f32,
    out_cap: usize,
) -> i32 {
    if bytes.is_null() || out.is_null() {
        return -1;
    }
    // `out` is written via `copy_nonoverlapping` below as `*mut f32` — reject
    // a mis-aligned buffer up front (UB otherwise), mirroring the alignment
    // guards in `render.rs` / `gpu_auto_profile.rs`.
    if (out as usize) % std::mem::align_of::<f32>() != 0 {
        return -1;
    }

    let input = std::slice::from_raw_parts(bytes, len);
    let lut = match decode_mlut(input) {
        Ok(l) => l,
        Err(e) => {
            set_last_error(format!("maple_film_lut_decode: {e}"));
            return -1;
        }
    };
    if lut.data.len() > out_cap {
        set_last_error(format!(
            "maple_film_lut_decode: out_cap {out_cap} too small for grid size {} \
             ({} floats needed) — re-call with a larger buffer",
            lut.size,
            lut.data.len()
        ));
        return -2;
    }
    // SAFETY: `out` validated non-null + f32-aligned above; the caller
    // guarantees it is writable for `out_cap >= lut.data.len()` floats.
    std::ptr::copy_nonoverlapping(lut.data.as_ptr(), out, lut.data.len());
    lut.size as i32
}
