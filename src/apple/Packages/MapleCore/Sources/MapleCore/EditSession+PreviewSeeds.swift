// EditSession+PreviewSeeds.swift — cold-open preview seeding.
//
// Owns every "paint something before the real decode lands" path: the
// rendered-preview disk-cache seed (+ its viewport-race retry, #2041), the
// `.maple` sidecar-preview seed, the embedded-JPEG seed, and the
// browse-grid thumbnail seed (#2040). Split out of
// EditSession+Hydration.swift to keep that file inside the #785 file-size
// budget; the nonisolated embedded-preview reader stays in Hydration.

import Foundation
import CoreImage
import ImageIO

@MainActor
extension EditSession {
    // MARK: - Preview seeds (cache + embedded JPEG)

    /// Returns true if a cached rendered preview was loaded and the
    /// session state was updated. Writes the decoded-image cache via
    /// `renderActor.seedIfUnpopulated(...)` so the check+write is
    /// atomic against the background Rust decode landing first (issue
    /// #194 slice 2). When the actor refuses the seed (a better buffer
    /// is already cached), `renderedPreview` is left alone.
    func seedFromCachedPreview(for asset: AssetRef) async -> Bool {
        guard let url = asset.primaryURL else { return false }
        // `|| previewIsThumbnailSeed`: the #2040 thumbnail seed may already
        // have published a placeholder-quality `renderedPreview` — that seed
        // is strictly coarser than this cache, so it must not block the
        // cache from landing on top of it.
        guard renderedPreview == nil || previewIsThumbnailSeed else { return false }
        guard previewSize.width >= 1 else {
            // `ensureRenderStarted()` fired before the canvas laid out and
            // pushed a real viewport (documented race on that method's doc
            // comment) — `previewSize` is still `.zero`, or a sub-pixel
            // layout-churn transient that would truncate to bucket 0, which
            // no store path ever writes (persist clamps to ≥ 1). Either way
            // the lookup buckets on a `screenWidth` that can never match a
            // previous session's real-width entry — `RenderedPreviewCache`
            // folds screenWidth into its key — so it's a guaranteed miss,
            // not a real one. Flag the retry instead of burning it;
            // `previewSize`'s `didSet` re-runs this once the real viewport
            // lands (#2041).
            cachedPreviewSeedPendingViewport = true
            return false
        }
        let w = Int(previewSize.width)
        let cached = await RenderedPreviewCache.shared
            .preview(for: url, screenWidth: w)
        guard let cached else { return false }
        guard self.asset.id == asset.id else { return false }
        let normalized = decodedForNativeCanvas(cached, asset: asset)
        let accepted = await renderActor.seedIfUnpopulated(
            asset: asset,
            decoded: normalized,
            rawResolution: cached.extent.size
        )
        guard accepted else { return false }
        // Only publish the lower-quality buffer to the canvas once the
        // actor has accepted it — otherwise the Rust decode already
        // wrote a better cache and we'd be downgrading the visible
        // preview for no reason.
        renderedPreview = cached
        previewIsFullRender = false
        previewIsThumbnailSeed = false
        editSessionLogger.debug(
            "cached preview seeded decode extent=\(cached.extent.width)x\(cached.extent.height)"
        )
        return true
    }

    /// Re-attempts `seedFromCachedPreview` once the real viewport width is
    /// known (#2041). Called from `previewSize`'s `didSet` on the first
    /// zero→real transition, i.e. at most once per cold-open.
    ///
    /// `seedFromCachedPreview`'s own `renderedPreview == nil` guard is the
    /// same atomicity contract every other cold-open seed already leans
    /// on — a placeholder that landed while the real width was still
    /// unknown (embedded JPEG, `.maple` sidecar preview, or the Rust
    /// decode itself) is left alone; this only fills the slot when
    /// nothing has published into it yet.
    func retryCachedPreviewSeedIfPending() {
        guard cachedPreviewSeedPendingViewport else { return }
        cachedPreviewSeedPendingViewport = false
        // Same asset-id guard the other async cold-open seeds use: capture
        // now, re-check after the `await` in case the user switched assets
        // (filmstrip sibling) while the lookup was in flight.
        let openedAsset = self.asset
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard self.asset.id == openedAsset.id else { return }
            let hit = await self.seedFromCachedPreview(for: openedAsset)
            // Re-check AFTER the await too: the disk lookup suspends, so
            // the user may have switched assets while it was in flight — a
            // stale hit must not schedule a render for the old asset.
            guard self.asset.id == openedAsset.id else { return }
            if hit {
                self._scheduleRender(phase: .fast)
            }
        }
    }

    /// Returns true if the embedded JPEG preview was loaded and seeded
    /// into the actor's decoded-image cache. Same atomicity contract as
    /// `seedFromCachedPreview` above.
    func seedFromEmbeddedPreview(for asset: AssetRef) async -> Bool {
        guard let url = asset.primaryURL else { return false }
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        // #1909 hardening: `url`/`scope` captured explicitly (both value
        // types — the capture list snapshots them rather than leaning on
        // implicit closure capture) before this executor hop off @MainActor.
        // `readEmbeddedPreview` itself wraps its ImageIO work in an explicit
        // `autoreleasepool` (EditSession+Hydration.swift) — see that doc
        // comment for the full #1909 rationale; this call site is the other
        // half of the same regression guard, so the hop is documented where
        // the `CIImage` actually crosses back onto @MainActor via `.value`.
        let ci: CIImage? = await Task.detached(priority: .userInitiated) { [url, scope] () -> CIImage? in
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            return EditSession.readEmbeddedPreview(from: url)
        }.value
        guard let ci else { return false }
        guard self.asset.id == asset.id else { return false }
        let normalized = decodedForNativeCanvas(ci, asset: asset)
        let accepted = await renderActor.seedIfUnpopulated(
            asset: asset,
            decoded: normalized,
            rawResolution: ci.extent.size
        )
        guard accepted else { return false }
        renderedPreview = ci
        previewIsFullRender = false
        previewIsThumbnailSeed = false
        editSessionSignposter.emitEvent("embedded paint")
        editSessionLogger.debug(
            "embedded preview seeded decode extent=\(ci.extent.width)x\(ci.extent.height)"
        )
        return true
    }

    /// Returns true if the `.maple/previews` baked preview was loaded and
    /// seeded into the actor's decoded-image cache. Same atomicity contract as
    /// `seedFromEmbeddedPreview`. Primary instant cold-open path for a pano,
    /// whose 16-bit PNG has no embedded JPEG and whose full develop is slow. (#1365.)
    func seedFromMapleSidecarPreview(for asset: AssetRef) async -> Bool {
        guard let url = asset.primaryURL else { return false }
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        // #1909 hardening: same explicit-capture + documented-hop pattern as
        // `seedFromEmbeddedPreview` above — see that comment and
        // `readMapleSidecarPreview`'s doc comment (EditSession+Hydration.swift)
        // for the full rationale.
        let ci: CIImage? = await Task.detached(priority: .userInitiated) { [url, scope] () -> CIImage? in
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            return EditSession.readMapleSidecarPreview(from: url)
        }.value
        guard let ci else { return false }
        guard self.asset.id == asset.id else { return false }
        let normalized = decodedForNativeCanvas(ci, asset: asset)
        let accepted = await renderActor.seedIfUnpopulated(
            asset: asset,
            decoded: normalized,
            rawResolution: ci.extent.size
        )
        guard accepted else { return false }
        renderedPreview = ci
        previewIsFullRender = false
        previewIsThumbnailSeed = false
        editSessionSignposter.emitEvent("maple sidecar preview paint")
        editSessionLogger.debug(
            "maple sidecar preview seeded decode extent=\(ci.extent.width)x\(ci.extent.height)"
        )
        return true
    }

    // MARK: - Thumbnail seed (fastest possible cold-open pixels, #2040)

    /// Publish the browse-grid thumbnail as the initial `renderedPreview`,
    /// synchronously, if — and only if — one is already hot in
    /// `ThumbnailDiskCache`'s in-memory sync-peek cache. This is strictly
    /// FASTER than every other seed above: no disk I/O, no actor hop, no
    /// `await` at all, so it can run inline in `ensureRenderStarted()` before
    /// the cold-open `Task` is even created. The grid the user just tapped
    /// through decoded and cached this exact thumbnail moments earlier via
    /// `ThumbnailLoader`, so a hit is the common case for grid → editor
    /// navigation (a miss — direct deep-link open, cold cache — silently
    /// no-ops and the editor falls through to the cache/embedded/Rust seeds
    /// exactly as it did before this existed).
    ///
    /// Guards on `renderedPreview == nil` itself (belt-and-suspenders on top
    /// of `ensureRenderStarted`'s own check immediately before calling this)
    /// so it can never clobber a richer seed or a real render regardless of
    /// call site — mirrors `seedFromCachedPreview`'s explicit guard above.
    ///
    /// Deliberately bypasses `renderActor.seedIfUnpopulated`: the thumbnail
    /// is a 256px AVIF grid encode, far too coarse to serve as filter-chain
    /// input for a real render, so it must stay purely cosmetic (a canvas
    /// backdrop only) and never occupy the decoded-image cache slot the
    /// richer seeds below need to write into. `previewIsFullRender` stays
    /// false (same as every other seed), which is what keeps this out of
    /// `persistCurrentPreviewToCache` and
    /// `ThumbnailLoader.updateThumbnailFromRender` — both gate on a real
    /// render (`previewIsFullRender` / `coversCanvas`), neither of which this
    /// seed ever sets — so the thumbnail can never feed back into the very
    /// thumbnail cache it came from. `previewIsThumbnailSeed` is set instead,
    /// so `seedFromCachedPreview`'s own guard still lets the richer cache
    /// preview overwrite this seed once it lands.
    func seedFromThumbnailIfAvailable() {
        guard renderedPreview == nil,
              let data = ThumbnailDiskCache.shared.syncPeekData(forKey: thumbnailCacheKey),
              let ci = CIImage(data: data)
        else { return }
        // Published AS-IS, deliberately NOT through `decodedForNativeCanvas`:
        // the other seeds publish their un-normalized image too (normalizing
        // only the copy they hand to `renderActor`, which this seed skips
        // entirely). Scaling the 256px thumbnail's extent up to
        // `nativeImageSize` here would make `CanvasImageView`'s
        // `createCGImage(from: image.extent)` rasterize a sensor-sized RGBA16
        // bitmap (~800 MB on a 100 MP RAW) just to paint a temporary
        // backdrop — SwiftUI's `.fit` scaling of the small raster is the
        // right (and existing) upscale path. (Copilot review, this PR.)
        renderedPreview = ci
        previewIsFullRender = false
        previewIsThumbnailSeed = true
        editSessionLogger.debug(
            "thumbnail seeded as initial canvas preview extent=\(ci.extent.width)x\(ci.extent.height)"
        )
    }

    /// The key `ThumbnailDiskCache` stores this asset's thumbnail under.
    /// Mirrors `ThumbnailLoader.load(for:from:)`'s / `ThumbnailProvider
    /// .cachedThumbnail(for:)`'s derivation exactly: basename for
    /// filesystem-backed assets, `stableID` (falling back to `displayName`,
    /// itself never empty — see `AssetRef.displayName`) for sourceless assets
    /// (PhotoKit, Self Hosted) with no URL to hash.
    private var thumbnailCacheKey: String {
        asset.primaryURL?.lastPathComponent ?? asset.stableID ?? asset.displayName
    }
}
