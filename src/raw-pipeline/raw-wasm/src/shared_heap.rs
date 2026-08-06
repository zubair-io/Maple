//! #2516 — safe Rayon restoration on Chromium without post-pool
//! shared-memory growth.
//!
//! ## Root cause (retained from #2515)
//!
//! The trapped PC is an `i32.atomic.load` inside an idle Rayon worker,
//! reached through `crossbeam_epoch::Global::try_advance` →
//! `crossbeam_deque::Stealer::steal` → `rayon_core::registry::WorkerThread::
//! wait_until_cold`. Chromium/V8 updates the *requesting* isolate's view of
//! a grown `SharedArrayBuffer` synchronously, but broadcasts the new bounds
//! to *other* isolates (each Rayon worker is a separate V8 isolate sharing
//! the same backing store) asynchronously. Maple's allocator calls
//! `memory.grow` repeatedly while decoding a large RAW (dlmalloc's `sbrk`
//! shim grows the WASM heap on demand), and with eight Rayon workers alive
//! and idle-parked between jobs, an idle worker can resume on a stale bound
//! and trap on an otherwise-valid atomic load.
//!
//! `wasm_bindgen_rayon`'s global thread pool can only be built once per WASM
//! instance (`rayon::ThreadPoolBuilder::build_global` fails on a second
//! call), so the pool is not something we can safely tear down and rebuild
//! per RAW — the fix has to prevent the race, not paper over it.
//!
//! ## Two rejected experiments (do not repeat without new allocator proof)
//!
//! - Warming the Rust allocator up to ~3.75 GiB by *touching* (writing)
//!   pages worked functionally, but the writes themselves physically
//!   committed ~2.5 GiB RSS and turned a 22 MP open into a ~24s stall.
//! - Fixing `initial == maximum` at link time still trapped, at a different
//!   PC (`__wbindgen_malloc` on the very first RAW allocation) — a distinct
//!   defect from the crossbeam race, not a fix for it.
//!
//! ## Two MORE approaches, found and ruled out while building this fix
//!
//! - A raw `memory.grow` WASM intrinsic (`core::arch::wasm32::memory_grow`)
//!   call, reasoning that a `memory.grow` only has to *reserve* the delta
//!   (new pages read as zero by spec — a freshly-mapped anonymous OS page
//!   already reads zero, so an engine can satisfy that without physically
//!   committing anything until the app writes to it) and so would be cheap.
//!   That reasoning about `memory.grow` itself held up (measured at
//!   0.09–0.11 ms for a multi-GiB grow), but the approach still failed
//!   empirically, immediately, THE SAME WAY as the rejected
//!   `initial == maximum` link-time experiment: an
//!   `alloc::alloc::handle_alloc_error` abort on the very first real
//!   allocations afterward (`rawler`'s RAW-buffer allocation, then
//!   `raw_core::color::dcp::apply_colorimetry`), even with the grow target
//!   set to within a few dozen MiB of the linked 4 GiB ceiling — i.e. plenty
//!   of headroom existed, and it still aborted. Root cause:
//!   `core::arch::wasm32::memory_grow` calls the WASM `memory.grow`
//!   instruction DIRECTLY, bypassing the global allocator (dlmalloc on
//!   wasm32-unknown-unknown) entirely. dlmalloc tracks its own heap as a
//!   list of segments it grew ITSELF via its own `sys_alloc`/sbrk path; a
//!   `memory.grow` it didn't issue is invisible to that bookkeeping. The
//!   next real allocation still goes through dlmalloc's segment/free-list
//!   logic, which computes its own next-grow request from ITS last-known
//!   size — now stale relative to the actual (externally-grown) WASM memory
//!   size — and that mismatch corrupts its arithmetic into spurious
//!   allocation failures. This is very likely the exact same underlying
//!   defect the retained `initial == maximum` link-time experiment hit: both
//!   bypass dlmalloc's own view of how much memory it owns.
//! - Growing THROUGH the allocator (this fix's approach, below) but in a
//!   SINGLE `std::alloc::alloc` call for the whole target. wasm32
//!   pointers/`isize` are 32-bit, so `Layout::from_size_align` rejects ANY
//!   single request whose size would overflow `isize::MAX` (~2 GiB) — a hard
//!   Rust-level constraint on 32-bit targets, independent of the WASM 4 GiB
//!   memory ceiling. This panicked (`Layout::from_size_align` returned
//!   `Err`) the moment the target crossed ~2047 MiB.
//!
//! A fourth pitfall, found the same way: allocating each [`CHUNK_MIB`] piece
//! and freeing it IMMEDIATELY (before requesting the next chunk) doesn't
//! work either — it hangs forever. The freed chunk is exactly the size the
//! next iteration asks for, so dlmalloc satisfies that request straight from
//! its free list without growing further, `memory_size()` never advances
//! past the first grow, and the "have we reached the target" loop condition
//! never becomes true. The fix (below) holds every chunk live until the
//! target is reached, THEN frees them all.
//!
//! ## This fix
//!
//! [`prepare_threaded_heap`] grows memory THROUGH the global allocator, in
//! [`CHUNK_MIB`]-sized pieces, held live in a `Vec` until the target is
//! reached (see the pitfall above for why), then freed all at once — in
//! REVERSE allocation order, so each chunk's address-adjacent predecessor is
//! already free by the time it's freed, letting dlmalloc coalesce them back
//! into one contiguous free region instead of `target_mib / CHUNK_MIB`
//! fragments. Nothing is ever written to any chunk. dlmalloc services each
//! allocation with its normal `sys_alloc` path (a real `memory.grow` it
//! issued itself, correctly recorded as one of its segments), then returns
//! the coalesced region to its free list on the final dealloc pass —
//! available for later real allocations to reuse without a further grow.
//! Because dlmalloc did the growing itself, its bookkeeping stays internally
//! consistent; because nothing is written, it's still cheap (no physical RSS
//! commit, no per-byte cost); because each chunk stays comfortably under the
//! 32-bit `isize::MAX` layout ceiling, construction cannot fail. Called
//! once, from the render worker's bootstrap, strictly BEFORE
//! `initThreadPool` spawns any Rayon worker. `raw-wasm`'s linker
//! `--max-memory=4294967296` (see
//! `raw-wasm/.cargo/config.toml`) already reserves the full wasm32 4 GiB
//! address ceiling as virtual space; this only changes how much of it
//! dlmalloc already owns before any worker isolate exists. The target size
//! is a measured evidence-based ceiling (see `raw-wasm-init.ts`'s
//! `THREADED_HEAP_TARGET_MIB` — that's the constant to look at; nothing in
//! THIS file needs to change when it's revalidated), not the full 4 GiB — a
//! full-native-resolution decode of Maple's largest supported RAW (100 MP)
//! already exceeds the 4 GiB ceiling on every runtime, a separate
//! pre-existing memory-budget defect this module does not attempt to fix.
//! **That will change once #2677 (large-sensor CPU develop clamp, open at
//! time of writing) lands** — see `THREADED_HEAP_TARGET_MIB`'s own comment
//! in `raw-wasm-init.ts` for the projected impact on the target size.
//!
//! Because no worker isolate is alive yet when this runs, there is nothing
//! to desync: disjunct (a) of #2516's acceptance criteria ("no shared-memory
//! growth occurs after worker isolates start") holds by construction, not by
//! timing. dlmalloc still grows memory normally afterward if genuine demand
//! ever exceeds the reserved ceiling (unchanged, pre-existing behavior) —
//! this only removes the *routine* growth that happens while the pool is
//! alive for realistic RAW sizes.
use wasm_bindgen::prelude::*;

// Real users are the wasm32 bodies below; `cfg(test)` also pulls these in so
// the pure arithmetic gets plain native test coverage (see the module doc on
// `src/tests.rs`-style native testing — raw-wasm has no wasm32 test runner).
// Off wasm32 in a non-test build, `wasm_memory_mib`/`prepare_threaded_heap`
// are no-op stubs that need none of this, so it would otherwise be dead code.
#[cfg(any(target_arch = "wasm32", test))]
const PAGE_BYTES: u64 = 65536;
#[cfg(any(target_arch = "wasm32", test))]
const BYTES_PER_MIB: u64 = 1024 * 1024;

#[cfg(any(target_arch = "wasm32", test))]
fn pages_to_mib(pages: u64) -> u32 {
    (pages * PAGE_BYTES / BYTES_PER_MIB) as u32
}

/// Current WASM linear memory size, in MiB. Diagnostic-only; used by tests
/// and browser evidence-gathering, not by the render hot path.
#[wasm_bindgen]
pub fn wasm_memory_mib() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        pages_to_mib(core::arch::wasm32::memory_size(0) as u64)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// Per-request cap for [`prepare_threaded_heap`]'s allocate-then-free calls —
/// see the module doc's "single `alloc` call" rejection for why this must
/// stay well under the wasm32 `isize::MAX` (~2 GiB) layout ceiling.
#[cfg(any(target_arch = "wasm32", test))]
const CHUNK_MIB: u32 = 512;

/// Grows the shared WASM linear memory to at least `target_mib` and returns
/// the resulting size in MiB. Grows THROUGH the global allocator, in
/// `CHUNK_MIB`-sized pieces (allocate, then immediately free, without
/// writing) rather than a raw `memory.grow` intrinsic or one giant
/// allocation — see the module doc for why both distinctions are
/// load-bearing, not stylistic.
///
/// Must be called before `initThreadPool` — see the module doc for why.
/// Idempotent: a memory already at or above `target_mib` (e.g. a second
/// session in the same worker) is a no-op. If a chunk allocation fails
/// (would exceed the linked `--max-memory` ceiling, or genuine host OOM),
/// this stops and returns whatever size was actually reached rather than the
/// requested one, so the caller can decide whether threading is still safe
/// to enable.
///
/// No-op (returns 0) off wasm32 — the native host build never calls this
/// (it's `parallel`+wasm32-gated at the call site) and has no equivalent
/// linear-memory-growth concept to prepare.
#[wasm_bindgen]
pub fn prepare_threaded_heap(target_mib: u32) -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::memory_size;
        // Chunks MUST stay live (not freed) until every chunk is allocated —
        // freeing each one immediately after allocating it (the first
        // version of this loop) hands dlmalloc back exactly the free block
        // it needs to satisfy the NEXT iteration's identically-sized
        // request, so `memory_size()` never advances past the first grow and
        // the loop never terminates. Held live, each iteration's request
        // finds nothing reusable in the free list and forces dlmalloc to
        // grow again. Freed in REVERSE order at the end so each chunk's
        // predecessor is already free when it's freed — dlmalloc coalesces
        // address-adjacent free blocks, so this leaves ONE contiguous free
        // region behind rather than `target_mib / CHUNK_MIB` fragments.
        let mut chunks: Vec<(*mut u8, std::alloc::Layout)> = Vec::new();
        loop {
            let current_mib = pages_to_mib(memory_size(0) as u64);
            if current_mib >= target_mib {
                break;
            }
            let chunk_mib = (target_mib - current_mib).min(CHUNK_MIB);
            let bytes = (chunk_mib as usize).saturating_mul(BYTES_PER_MIB as usize);
            // 16-byte alignment matches dlmalloc's own minimum chunk
            // alignment on wasm32, so this reservation doesn't force an odd
            // split. `chunk_mib` is capped at `CHUNK_MIB` (512), so `bytes`
            // is nowhere near the 32-bit `isize::MAX` layout ceiling —
            // construction cannot fail here.
            let layout = std::alloc::Layout::from_size_align(bytes, 16)
                .expect("CHUNK_MIB-sized layout must be valid on wasm32");
            // SAFETY: `layout` is non-zero-sized (chunk_mib > 0, since
            // current_mib < target_mib here) and correctly constructed
            // above. The returned pointer is never read or written — only
            // held until the final dealloc pass below — so this is sound
            // regardless of whether the allocator zeroed it.
            let ptr = unsafe { std::alloc::alloc(layout) };
            if ptr.is_null() {
                // This chunk failed outright (e.g. would exceed
                // --max-memory, or genuine host OOM). Stop; the chunks
                // gathered so far are still freed below before returning.
                break;
            }
            chunks.push((ptr, layout));
        }
        let achieved_mib = pages_to_mib(memory_size(0) as u64);
        for (ptr, layout) in chunks.into_iter().rev() {
            // SAFETY: `ptr` was returned by `alloc` with this exact
            // `layout` above, is non-null, and is freed exactly once, here.
            unsafe { std::alloc::dealloc(ptr, layout) };
        }
        achieved_mib
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = target_mib;
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_to_mib_round_trips_whole_mib_targets() {
        assert_eq!(pages_to_mib(16), 1);
        assert_eq!(pages_to_mib(16 * 3072), 3072);
    }

    #[test]
    fn chunk_mib_stays_well_under_the_wasm32_isize_layout_ceiling() {
        // wasm32 `isize::MAX` is i32::MAX (~2 GiB) — see the module doc's
        // "single alloc call" rejection. CHUNK_MIB must have generous margin
        // below that, in MiB.
        const WASM32_ISIZE_MAX_MIB: u32 = (i32::MAX as u64 / BYTES_PER_MIB) as u32;
        assert!(
            CHUNK_MIB < WASM32_ISIZE_MAX_MIB / 2,
            "CHUNK_MIB ({CHUNK_MIB}) must stay well under the wasm32 isize::MAX layout ceiling \
             ({WASM32_ISIZE_MAX_MIB} MiB)",
        );
    }
}
