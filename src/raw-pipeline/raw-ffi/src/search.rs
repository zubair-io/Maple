//! In-process hybrid search C ABI over `maple_search::SearchEngine` (#4462).
//! No API code calls it yet by design: the search child process and the
//! `/api/search` cut-over setting that consume it are #4463 (epic #4460).
//!
//! **API-only.** Compiled only under the `search` feature, which only the
//! Self Hosted API's bun:ffi dylib build enables (`src/api/scripts/
//! build-raw-ffi.sh`). The declarations sit behind `#if defined(MAPLE_SEARCH)`
//! in the generated header, no Apple slice or Windows DLL contains them, and
//! they have no Swift or C# mirror.
//!
//! One handle is one engine and is safe to share across threads; closing it
//! while another call is in flight is the caller's bug.
//!
//! Return codes: 0 ok, 1 null or non-UTF-8 argument, 2 the engine reported an
//! error (`maple_last_error` has it), 99 panic caught, 100 `out_buf` too
//! small (`*out_len` holds the size needed, so a null buffer is a size probe;
//! the query is not cached, so the retry searches again).

use crate::error::{catch_panic_rc, set_last_error};
use maple_search::{FusedHit, SearchConfig, SearchEngine, DIM};
use std::ffi::{c_char, CStr};

const RC_INVALID_ARGUMENT: i32 = 1;
const RC_ENGINE_ERROR: i32 = 2;
const RC_NEED_LARGER_BUFFER: i32 = 100;

/// Opaque search engine handle; see `maple_search_open`.
pub struct MapleSearchHandle(SearchEngine);

unsafe fn utf8<'a>(text: *const c_char, what: &str) -> Result<&'a str, i32> {
    if text.is_null() {
        set_last_error(format!("{what} is null"));
        return Err(RC_INVALID_ARGUMENT);
    }
    CStr::from_ptr(text).to_str().map_err(|_| {
        set_last_error(format!("{what} is not valid UTF-8"));
        RC_INVALID_ARGUMENT
    })
}

unsafe fn engine<'a>(handle: *const MapleSearchHandle) -> Result<&'a SearchEngine, i32> {
    if handle.is_null() {
        set_last_error("search handle is null".into());
        return Err(RC_INVALID_ARGUMENT);
    }
    Ok(&(*handle).0)
}

fn engine_result<T>(result: maple_search::Result<T>) -> Result<T, i32> {
    result.map_err(|e| {
        set_last_error(e.to_string());
        RC_ENGINE_ERROR
    })
}

fn rc(outcome: Result<(), i32>) -> i32 {
    outcome.err().unwrap_or(0)
}

/// Opens an engine from a JSON config:
/// `{"index_dir": "...", "embedder": {"model_cache_dir": "...",
/// "ort_dylib_path": "...", "intra_threads": 4}}` — `embedder` and its last
/// two keys are optional. Returns null on failure (`maple_last_error` says
/// why). API-only (`search` feature).
///
/// # Safety
/// `config_json` must be a NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn maple_search_open(config_json: *const c_char) -> *mut MapleSearchHandle {
    let opened = std::panic::catch_unwind(|| {
        let json = utf8(config_json, "config").ok()?;
        let config = engine_result(SearchConfig::from_json(json)).ok()?;
        engine_result(SearchEngine::open(&config)).ok()
    });
    match opened {
        Ok(Some(engine)) => Box::into_raw(Box::new(MapleSearchHandle(engine))),
        Ok(None) => std::ptr::null_mut(),
        Err(_) => {
            set_last_error("maple_search_open: panicked".into());
            std::ptr::null_mut()
        }
    }
}

/// Frees a handle from `maple_search_open`. Null is a no-op. API-only.
///
/// # Safety
/// `handle` must come from `maple_search_open` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn maple_search_close(handle: *mut MapleSearchHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// Replaces the vector matrix: `vectors` is `ids` rows of 1024 little-endian
/// f32, `ids` is the matching UTF-8 ids joined by `\n`. API-only.
///
/// # Safety
/// `vectors` must be valid for `vectors_len` bytes and `ids` for `ids_len`.
#[no_mangle]
pub unsafe extern "C" fn maple_search_load_vectors(
    handle: *const MapleSearchHandle,
    vectors: *const u8,
    vectors_len: usize,
    ids: *const u8,
    ids_len: usize,
) -> i32 {
    catch_panic_rc("maple_search_load_vectors", || {
        rc(engine(handle).and_then(|engine| {
            let vectors = bytes(vectors, vectors_len, "vectors")?;
            let ids = std::str::from_utf8(bytes(ids, ids_len, "ids")?).map_err(|_| {
                set_last_error("ids are not valid UTF-8".into());
                RC_INVALID_ARGUMENT
            })?;
            let ids = if ids.is_empty() {
                Vec::new()
            } else {
                ids.split('\n').map(str::to_owned).collect()
            };
            engine_result(engine.load_vectors(vectors, ids)).map(|_| ())
        }))
    })
}

/// Embeds `query`, searches both legs and writes the fused top `k` as a JSON
/// array of `{"id","score","vector_rank","text_rank"}` (ranks are 1-based or
/// null). API-only.
///
/// # Safety
/// `query` must be a NUL-terminated string, `out_len` non-null, and a
/// non-null `out_buf` valid for `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn maple_search_query(
    handle: *const MapleSearchHandle,
    query: *const c_char,
    k: u32,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_search_query", || {
        rc(engine(handle).and_then(|engine| {
            let query = utf8(query, "query")?;
            let hits = engine_result(engine.search(query, k as usize))?;
            write_hits(&hits, out_buf, out_cap, out_len)
        }))
    })
}

/// `maple_search_query` with a caller-supplied query vector of `dim` f32
/// (must be 1024) instead of the engine's embedder. API-only.
///
/// # Safety
/// As `maple_search_query`; `vector` must be valid for `dim` f32.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_search_query_vector(
    handle: *const MapleSearchHandle,
    query: *const c_char,
    vector: *const f32,
    dim: usize,
    k: u32,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_search_query_vector", || {
        rc(engine(handle).and_then(|engine| {
            let query = utf8(query, "query")?;
            let vector = floats(vector, dim)?;
            let hits = engine_result(engine.search_with_vector(query, vector, k as usize))?;
            write_hits(&hits, out_buf, out_cap, out_len)
        }))
    })
}

/// Inserts or replaces `id`. A null `vector` leaves its vector untouched,
/// otherwise it must hold `dim` (1024) f32; a null `text` leaves its text
/// untouched. Vectors apply at once, text on `maple_search_commit`. API-only.
///
/// # Safety
/// `id` and a non-null `text` must be NUL-terminated strings; a non-null
/// `vector` must be valid for `dim` f32.
#[no_mangle]
pub unsafe extern "C" fn maple_search_upsert(
    handle: *const MapleSearchHandle,
    id: *const c_char,
    vector: *const f32,
    dim: usize,
    text: *const c_char,
) -> i32 {
    catch_panic_rc("maple_search_upsert", || {
        rc(engine(handle).and_then(|engine| {
            let id = utf8(id, "id")?;
            let vector = if vector.is_null() {
                None
            } else {
                Some(floats(vector, dim)?)
            };
            let text = if text.is_null() {
                None
            } else {
                Some(utf8(text, "text")?)
            };
            engine_result(engine.upsert(id, vector, text))
        }))
    })
}

/// Removes `id` from both legs (text on `maple_search_commit`). API-only.
///
/// # Safety
/// `id` must be a NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn maple_search_delete(
    handle: *const MapleSearchHandle,
    id: *const c_char,
) -> i32 {
    catch_panic_rc("maple_search_delete", || {
        rc(engine(handle).and_then(|engine| {
            engine.delete(utf8(id, "id")?);
            Ok(())
        }))
    })
}

/// Stages removal of every text document: a full rebuild is clear, upsert
/// each row's text, commit. Searches see the old index until the commit.
/// API-only.
///
/// # Safety
/// `handle` must come from `maple_search_open`.
#[no_mangle]
pub unsafe extern "C" fn maple_search_clear_text(handle: *const MapleSearchHandle) -> i32 {
    catch_panic_rc("maple_search_clear_text", || {
        rc(engine(handle).and_then(|engine| engine_result(engine.clear_text())))
    })
}

/// Makes staged text changes durable and visible to searches. API-only.
///
/// # Safety
/// `handle` must come from `maple_search_open`.
#[no_mangle]
pub unsafe extern "C" fn maple_search_commit(handle: *const MapleSearchHandle) -> i32 {
    catch_panic_rc("maple_search_commit", || {
        rc(engine(handle).and_then(|engine| engine_result(engine.commit())))
    })
}

/// Writes the number of loaded vectors and committed text documents.
/// API-only.
///
/// # Safety
/// `out_vectors` and `out_texts` must be valid for one `u64` each.
#[no_mangle]
pub unsafe extern "C" fn maple_search_counts(
    handle: *const MapleSearchHandle,
    out_vectors: *mut u64,
    out_texts: *mut u64,
) -> i32 {
    catch_panic_rc("maple_search_counts", || {
        rc(engine(handle).and_then(|engine| {
            if out_vectors.is_null() || out_texts.is_null() {
                set_last_error("count outputs are null".into());
                return Err(RC_INVALID_ARGUMENT);
            }
            *out_vectors = engine.vector_count() as u64;
            *out_texts = engine.text_count();
            Ok(())
        }))
    })
}

unsafe fn bytes<'a>(data: *const u8, len: usize, what: &str) -> Result<&'a [u8], i32> {
    match (data.is_null(), len) {
        (_, 0) => Ok(&[]),
        (true, _) => {
            set_last_error(format!("{what} is null"));
            Err(RC_INVALID_ARGUMENT)
        }
        (false, _) => Ok(std::slice::from_raw_parts(data, len)),
    }
}

unsafe fn floats<'a>(vector: *const f32, dim: usize) -> Result<&'a [f32], i32> {
    if vector.is_null() || dim != DIM {
        set_last_error(format!("vector must be {DIM} f32, got {dim}"));
        return Err(RC_INVALID_ARGUMENT);
    }
    Ok(std::slice::from_raw_parts(vector, dim))
}

unsafe fn write_hits(
    hits: &[FusedHit],
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> Result<(), i32> {
    if out_len.is_null() {
        set_last_error("out_len is null".into());
        return Err(RC_INVALID_ARGUMENT);
    }
    let json = serde_json::to_vec(hits).map_err(|e| {
        set_last_error(e.to_string());
        RC_ENGINE_ERROR
    })?;
    *out_len = json.len();
    if out_buf.is_null() || out_cap < json.len() {
        return Err(RC_NEED_LARGER_BUFFER);
    }
    std::ptr::copy_nonoverlapping(json.as_ptr(), out_buf, json.len());
    Ok(())
}
