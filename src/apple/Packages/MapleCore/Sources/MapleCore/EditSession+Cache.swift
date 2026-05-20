// EditSession+Cache.swift — decoded-image cache lifecycle + persistence.
//
// Split from `EditSession+Render.swift` / `EditSession+Decode.swift`
// (issue #120) so each file fits the ticket's 400-LOC ceiling and the
// cache state machine has one home.
//
// Owns:
//   • `invalidateDecodedCache` — drop all cached state for an asset switch
//   • `parseSidecarModel` / `sidecarMtime` — sidecar bookkeeping that
//     gates cache reuse and seals the cache against external XMP edits
//   • `decodedCacheIsFreshForCurrentAsset` — freshness check consumed by
//     the hot render path's cache-vs-cold branch in `decodeAndRender`
//   • `persistCurrentPreviewToCache` — snapshot of `renderedPreview` into
//     the disk-backed `RenderedPreviewCache` for the next cold open
//   • Test hooks for the cache state machine
//
// The stored cache fields themselves (`decodedImage`, `decodedAtModel`,
// `decodedForAssetID`, `decodedSidecarMtime`, `decodedRawResolution`,
// `decodeTask`, `refineDecodeTasks`) live on `EditSession` — Swift
// extensions can't add stored properties.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    // MARK: - Cache invalidation

    /// Drop the cached decoded CIImage — call after reloading the sidecar
    /// from disk or when the underlying asset bytes may have changed.
    public func invalidateDecodedCache() {
        decodedImage = nil
        decodedRawResolution = .zero
        decodedForAssetID = nil
        decodedSidecarMtime = nil
        decodeTask = nil
        decodeTaskAssetID = nil
        // Ticket 10 item H — clear the refine-decode coalescer so a fresh
        // schedule against the same `(asset, target)` doesn't piggy-back
        // on a now-stale in-flight decode (which captured the prior
        // sidecar / xmp state). In-flight tasks aren't cancelled here —
        // their detached work runs to completion and their result is
        // dropped by the gen check upstream.
        refineDecodeTasks.removeAll()
        // Plan 2 M3 — the next decode will re-parse the sidecar; clear
        // the cached snapshot so the WB delta can't compose against a
        // stale decode-time model.
        decodedAtModel = nil
        // Plan 3 — drop tile cache for this asset so the next deep-zoom
        // refine starts from a clean slate against the fresh decode.
        // The tile manager is per-session so we just clear it; the
        // events subscription stays alive (it's keyed off this manager
        // instance, not per-asset).
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
    func persistCurrentPreviewToCache() {
        guard let url = asset.primaryURL,
              let preview = renderedPreview else { return }
        let capturedImage = preview
        let capturedWidth = Int(max(previewSize.width, 1))
        Task.detached(priority: .utility) {
            await RenderedPreviewCache.shared.storePreview(
                capturedImage, for: url, screenWidth: capturedWidth
            )
        }
    }

    // MARK: - Sidecar helpers + cache freshness

    /// Plan 2 M3 — parse the asset's sidecar (if present on disk) into
    /// an AdjustmentModel. Used to capture the decode-time model so the
    /// WhiteBalance kernel can apply only the live-vs-decoded delta.
    /// Returns `.default` when no sidecar exists or the parse fails —
    /// this matches what the Rust path uses on the same condition.
    static func parseSidecarModel(for asset: AssetRef) -> AdjustmentModel {
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
    /// pre-DCP buffer. Sourceless assets (no `sidecarURL`) return `nil`;
    /// they don't have a file-shaped sidecar to track.
    static func sidecarMtime(for asset: AssetRef) -> Date? {
        guard let url = asset.sidecarURL,
              let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let mtime = attrs[.modificationDate] as? Date
        else { return nil }
        return mtime
    }

    /// Decoded-cache validity check. The cache is valid for the live hot
    /// path only when (asset matches) AND (sidecar mtime matches the
    /// capture). Mtime is `Date?` — a nil-vs-nil comparison (no sidecar
    /// existed at either decode time or now) is also valid. A captured
    /// mtime followed by a sidecar deletion (or vice versa) is treated
    /// as a change and invalidates.
    ///
    /// `internal` so the test suite can probe the cache state machine
    /// without standing up a full Rust decode.
    internal func decodedCacheIsFreshForCurrentAsset() -> Bool {
        guard decodedForAssetID == asset.id else { return false }
        let live = Self.sidecarMtime(for: asset)
        return live == decodedSidecarMtime
    }

    // MARK: - Test hooks

    /// Test hook — manually populate the cache fields with a synthetic
    /// CIImage so unit tests can verify the freshness check, the mtime-
    /// change invalidation contract, and the invalidate-clears-fields
    /// invariant without paying the Rust FFI's full-decode cost. NOT
    /// for production use; cold/hot decode paths set these via
    /// `sharedDecode`.
    internal func _testSeedDecodedCache(
        decoded: CIImage,
        rawResolution: CGSize,
        sidecarMtime: Date?,
        decodedAtModel: AdjustmentModel? = nil
    ) {
        self.decodedImage = decoded
        self.decodedRawResolution = rawResolution
        self.decodedForAssetID = self.asset.id
        self.decodedSidecarMtime = sidecarMtime
        self.decodedAtModel = decodedAtModel
    }

    /// Test inspector — true when `decodedImage` has been populated for
    /// the current asset. Mirrors the cold/hot dispatch the
    /// `decodeAndRender` cached branch relies on.
    internal var _testDecodedCachePopulated: Bool {
        decodedImage != nil && decodedForAssetID == asset.id
    }
}
