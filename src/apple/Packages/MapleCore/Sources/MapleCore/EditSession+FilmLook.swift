// EditSession+FilmLook.swift — film-look resolve + session push (epic #2683,
// Task 10). Split out of `EditSession+GpuLive.swift` for readability; the
// caller is `presentViaGpuLive`.
//
// FIX (review round 1): the original design pushed the resolved lattice
// from `model`'s `didSet` via an unstructured `Task`, while the SAME
// `didSet` scheduled the next render synchronously right after — a
// property observer can't `await`, so nothing enforced that the push
// landed before the scheduled render reached the FFI. In practice that
// meant a look SWITCH (or, worse, a sidecar-authored look on COLD OPEN,
// which never goes through `didSet` at all — hydration sets the model
// directly and short-circuits it) could present one film-less or
// stale-look frame before the session caught up.
//
// The fix follows `fitAutoProfileIfNeeded`'s precedent: instead of pushing
// from the model mutation, resolve + push at the START of the SAME async
// function that then calls `driver.present` (`presentViaGpuLive`). That
// makes the ordering airtight by construction — there is no `await` gap
// between "the session holds the new lattice" and "the present that reads
// it" because they're sequential statements in one `async` call, not two
// independent tasks racing each other. It also fixes the cold-open gap for
// free: `presentViaGpuLive` runs on every present, hydrated or not.

import Foundation

extension EditSession {
    /// Resolve `model.filmLook` and ensure `driver` holds the matching
    /// lattice before the caller presents. A cheap synchronous key
    /// comparison (`driver.currentFilmLutKey` — a MainActor read, no actor
    /// hop) makes every steady-state present a no-op; the `await` below
    /// only fires on an actual look SWITCH or the first present after open.
    /// A missing `.mlut` asset logs and clears the session's film state
    /// (identity) rather than erroring — mirrors `AutoProfileLUT`'s "render
    /// plain" fallback.
    func syncFilmLutForPresent(driver: GpuLiveDriver) async {
        let resolved = filmLutStore.lattice(for: model.filmLook)
        guard driver.currentFilmLutKey != resolved?.key else { return }
        if let resolved {
            await driver.setFilmLut(data: resolved.data, size: resolved.size, key: resolved.key)
        } else {
            await driver.clearFilmLut()
            if !model.filmLook.isEmpty {
                editSessionLogger.notice(
                    "film look \(self.model.filmLook, privacy: .public) not found — rendering without it")
            }
        }
    }
}
