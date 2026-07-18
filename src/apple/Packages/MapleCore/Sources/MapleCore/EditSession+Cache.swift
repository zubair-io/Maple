// EditSession+Cache.swift — cache forwarders + persistence + sidecar helpers.
//
// History: slice 2 of issue #194 moved the decoded-image cache fields and
// the `sharedDecode` / `coalescedRefineDecode` / `renderForExport` methods
// onto `RenderActor`. What's left here is:
//
//   • `persistCurrentPreviewToCache` — reads `renderedPreview` /
//     `previewSize` (EditSession-owned MainActor state), no coupling to
//     the decoded-image cache. Stays here per the slice-2 plan note.
//
//   • `parseSidecarModel` / `sidecarMtime` — pure static helpers used
//     by both the actor and EditSession. Static so they don't need a
//     MainActor hop and don't drag an `EditSession` instance into
//     RenderActor's call sites.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    // MARK: - Preview cache persistence

    /// Snapshot the current `renderedPreview` into `RenderedPreviewCache`
    /// so a future cold open of this asset can paint pixels instantly.
    /// Called from both the refine path (after refine publishes) and the
    /// refine-skip branch in `_scheduleRefine` — without the latter,
    /// fit-to-window opens (the most common case) never populate the
    /// cache and every cold re-open redoes the Rust pipeline.
    ///
    /// Persists only when `previewIsFullRender` — a cold-open seed or a
    /// patch-over-underlay composite must never reach the disk cache: the
    /// underlay may predate the current model (e.g. an exposure change), so
    /// baking the composite writes a hard tone seam that every subsequent
    /// cold open then re-displays (#1881).
    ///
    /// `!isFullQualityDecoding` closes the cold-open seed window: seeds are
    /// planted into the DECODED-image cache too, so a fast render during that
    /// window is a full-canvas render of chain(upscaled embedded JPEG), not of
    /// the real decode — plausible pixels, wrong provenance. The decode's
    /// completion re-kicks a render, so the cache still gets populated once
    /// real pixels exist.
    ///
    /// Returns whether a persist was actually scheduled, so tests can assert
    /// the provenance gate synchronously instead of sleeping and probing the
    /// disk for a write that must never happen.
    @discardableResult
    func persistCurrentPreviewToCache() -> Bool {
        guard previewIsFullRender,
              !isFullQualityDecoding,
              let url = asset.primaryURL,
              let preview = renderedPreview else { return false }
        let capturedImage = preview
        let capturedWidth = Int(max(previewSize.width, 1))
        Task.detached(priority: .utility) {
            await RenderedPreviewCache.shared.storePreview(
                capturedImage, for: url, screenWidth: capturedWidth
            )
        }
        return true
    }

    // MARK: - Memory pressure (#2037)

    /// Free every transient, re-derivable buffer this session holds: the
    /// decoded-image cache, the deep-zoom tile cache, and the wgpu live-
    /// render session's GPU buffers. Everything freed here is re-derived
    /// from the sidecar + RAW on next use — no user state (the model, undo
    /// stack, sidecar) is touched.
    ///
    /// AWAITS every teardown (rather than firing detached `Task`s) so a
    /// caller fanning out over `AppShell.sessions` under memory pressure
    /// knows the frees landed before it returns, and so a test can assert
    /// on the result synchronously.
    ///
    /// Callers decide which sessions this reaches — see `AppShell`'s
    /// `pruneInactiveSessions()` for how "active vs inactive" is already
    /// determined (the current `browseVM.selectedID`, while an image
    /// surface is open). The regular memory-pressure fan-out must skip the
    /// active session (dropping its decoded cache / GPU session would stall
    /// the on-screen edit — worse than the memory pressure itself); the
    /// iOS background fan-out includes it, since a backgrounded app has
    /// nothing "on screen" to stall and jetsam is the bigger risk.
    ///
    /// GPU-live sessions are self-healing: `GpuLiveDriver.isOpen` reports
    /// `false` once its session is `nil`, and the next `presentViaGpuLive`
    /// call (`EditSession+GpuLive.swift`) transparently re-reads back the
    /// decoded image and reopens — so closing here costs a re-upload (and,
    /// if the decoded cache was also dropped, a re-decode) on next visit,
    /// not correctness.
    public func releaseTransientMemory() async {
        await renderActor.invalidate()
        await tileManager?.clear()
        // #1881 — the on-screen preview (if any) now predates this eviction,
        // so a refine-skip persist must not write these stale pixels under a
        // fresh cache key later.
        previewIsFullRender = false
        await gpuLiveDriver?.closeSession()
    }

}

// MARK: - Sidecar helpers (nonisolated; called from RenderActor)

extension EditSession {
    /// Plan 2 M3 — parse the asset's sidecar (if present on disk) into
    /// an AdjustmentModel. Used to capture the decode-time model so the
    /// WhiteBalance kernel can apply only the live-vs-decoded delta.
    /// Returns `.default` when no sidecar exists or the parse fails —
    /// this matches what the Rust path uses on the same condition.
    ///
    /// `nonisolated` so the `RenderActor` can call it from its own
    /// actor executor without a MainActor hop. The implementation is
    /// pure file I/O against `asset.sidecarURL`; no state is read from
    /// `EditSession` itself.
    nonisolated static func parseSidecarModel(for asset: AssetRef) -> AdjustmentModel {
        guard let url = asset.sidecarURL,
              FileManager.default.fileExists(atPath: url.path)
        else {
            return .default
        }
        guard let xml = try? String(contentsOf: url, encoding: .utf8) else {
            return .default
        }
        guard let (m, _) = try? XMPParser.parse(xml) else {
            return .default
        }
        return m
    }

    /// Read the asset's sidecar mtime, or `nil` when no sidecar is on
    /// disk. Used to seal the decoded-image cache against external XMP
    /// edits — if the sidecar is rewritten (paste-adjustments, an
    /// external editor, the indexer), the next render must trigger a
    /// fresh decode rather than apply the new model on top of the stale
    /// pre-DCP buffer. `nonisolated` for the same reason as
    /// `parseSidecarModel`.
    nonisolated static func sidecarMtime(for asset: AssetRef) -> Date? {
        guard let url = asset.sidecarURL,
              let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let mtime = attrs[.modificationDate] as? Date
        else { return nil }
        return mtime
    }
}
