// EditSession+Cache.swift — cache forwarders + persistence + sidecar helpers.
//
// History: slice 2 of issue #194 moved the decoded-image cache fields and
// the `sharedDecode` / `coalescedRefineDecode` / `renderForExport` methods
// onto `RenderActor`. What's left here is:
//
//   • `invalidateDecodedCache` — public sync forwarder. Schedules a
//     `Task` that calls `renderActor.invalidate()` and clears the per-
//     session tile manager. Kept on EditSession so existing callers
//     (Settings UI, tests, external Browse paths) don't have to switch
//     to `await session.renderActor.invalidate()`.
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
    // MARK: - Cache invalidation forwarder

    /// Drop the cached decoded CIImage — call after reloading the
    /// sidecar from disk or when the underlying asset bytes may have
    /// changed.
    ///
    /// Synchronous-looking surface preserved for callers; the actor
    /// hop is fire-and-forget. In-flight render tasks observe the
    /// invalidation through the gen-counter guard upstream, so racing
    /// the actor write against a publish has the same effect as the
    /// pre-slice-2 inline mutation.
    public func invalidateDecodedCache() {
        let actor = renderActor
        Task { await actor.invalidate() }
        // Plan 3 — drop tile cache for this asset so the next deep-zoom
        // refine starts from a clean slate against the fresh decode.
        let mgr = tileManager
        Task { await mgr?.clear() }
    }

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
    func persistCurrentPreviewToCache() {
        guard previewIsFullRender,
              let url = asset.primaryURL,
              let preview = renderedPreview else { return }
        let capturedImage = preview
        let capturedWidth = Int(max(previewSize.width, 1))
        Task.detached(priority: .utility) {
            await RenderedPreviewCache.shared.storePreview(
                capturedImage, for: url, screenWidth: capturedWidth
            )
        }
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
