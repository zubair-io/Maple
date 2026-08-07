// EditSession+FilmLook.swift — film-look resolve + session push (epic #2683,
// Task 10). Split out of `EditSession.swift`'s `model` `didSet` to keep that
// file under the 600-line hard budget (CONTRIBUTING.md).

import Foundation

extension EditSession {
    /// Resolve `model.filmLook` via `filmLutStore` and push the result into
    /// the GPU-live session BEFORE the render `model`'s `didSet` schedules
    /// right after calling this, so the very next present picks up the new
    /// look rather than showing one extra stale-look frame first.
    ///
    /// Resolution itself (`FilmLutStore.lattice(for:)`) is synchronous
    /// (cached after the first load per id); only the push into the
    /// actor-isolated `GpuLiveSession` needs an `await`, so it's dispatched
    /// as a `Task` — same pattern as the sidecar write in `model`'s
    /// `didSet`. Because `_scheduleRender` still fires synchronously right
    /// after this returns (every model change re-renders regardless of
    /// this `Task`'s completion), a look SWITCH costs at most one extra
    /// self-correcting frame while the push lands. A missing `.mlut` asset
    /// logs and leaves the session's film state CLEARED (identity) rather
    /// than erroring — mirrors `AutoProfileLUT`'s "render plain" fallback.
    func updateFilmLutIfNeeded() {
        let resolved = filmLutStore.lattice(for: model.filmLook)
        if resolved == nil, !model.filmLook.isEmpty {
            editSessionLogger.notice(
                "film look \(self.model.filmLook, privacy: .public) not found — rendering without it")
        }
        Task { [weak self] in
            guard let self else { return }
            if let resolved {
                await self.gpuLiveDriver?.setFilmLut(
                    data: resolved.data, size: resolved.size, key: resolved.key)
            } else {
                await self.gpuLiveDriver?.clearFilmLut()
            }
        }
    }
}
