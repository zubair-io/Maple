// ThumbnailLoader+DisplayPreview.swift — the `.maple/previews` 1600 px
// display tier behind the Preview screen's thumbnail → display-res swap
// (spec §3 of docs/superpowers/specs/2026-07-06-fast-preview-and-phone-card-
// editor-design.md, slice A1).
//
// Split from ThumbnailLoader.swift for the file-size budget; shares the
// actor's decode-slot gate, in-flight coalescing map, and JPEG encoder.

import CoreImage
import Foundation
import ImageIO

extension ThumbnailLoader {

    /// Long-edge target for the display-preview tier at
    /// `MapleSidecarPaths.previewURL` (`.maple/previews/
    /// <sha256prefix16(basename)>_1600.jpg`). 1600 is the established
    /// convention: the pano stitcher writes it at stitch time (#1365) and
    /// `EditSession` cold-open seeding reads it — the Preview screen's
    /// display tier reuses the same artifact.
    public static let displayPreviewLongEdge: CGFloat = 1_600

    /// Below this long edge an embedded thumbnail is not worth swapping in:
    /// EXIF thumbs are ~160 px — worse than the grid thumbnail already on
    /// screen — while real embedded previews are ≥ 1024 on every modern body.
    private static let minUsefulEmbeddedLongEdge = 1_024

    /// Shared CIContext for the nonisolated static encode path below —
    /// `CIContext` is heavyweight to allocate and thread-safe to share
    /// (mirrors `posterCIContext` in ThumbnailLoader.swift), so fast paging
    /// never pays a per-encode context allocation.
    private static let displayPreviewCIContext = CIContext()

    /// Display-resolution JPEG for a URL-backed asset — the Preview screen's
    /// second tier (the thumbnail paints first, this swaps in when it
    /// resolves).
    ///
    /// Order of attempts:
    ///   1. Fresh `.maple/previews/<key>_1600.jpg` on disk — written by a
    ///      previous call, the pano stitcher (#1365), or the render-publish
    ///      refresh (`updateDisplayPreviewFromRender`).
    ///   2. Edited-photo gate: when the sidecar carries non-default
    ///      adjustments (beyond the as-shot WB seed) and step 1 missed,
    ///      return nil — the 256 px thumbnail already reflects the edits
    ///      (`updateThumbnailFromRender`), so swapping in camera-original
    ///      pixels would visibly revert them. The editor's render refresh
    ///      repopulates the tier with developed pixels.
    ///   3. Generate from the camera's embedded JPEG preview (never an
    ///      Apple-RAW full decode — its rendering diverges from the Maple
    ///      pipeline), persist to `.maple/previews/`, and return the bytes.
    ///      Non-RAW bitmaps with no useful embedded thumb decode exactly, so
    ///      they synthesize at target instead.
    ///
    /// Returns nil when no tier is available (edited-and-stale, RAW without
    /// an embedded preview, video/stub/audio) — the caller keeps showing the
    /// thumbnail, which is never wrong, just lower-res.
    public func loadDisplayPreview(for asset: AssetRef) async -> Data? {
        guard let url = asset.primaryURL, !asset.isVideo else { return nil }
        let ext = url.pathExtension.lowercased()
        if StubExtensions.all.contains(ext) || AudioExtensions.all.contains(ext) {
            return nil
        }

        // Coalesce duplicate requests (a pager scrub can ask for the same
        // page twice) under a namespaced key so it never collides with the
        // 256 px thumbnail entries in the same map. The check + task creation
        // + map insert below run with NO intervening `await`, so no second
        // caller can interleave and start a duplicate; the decode-slot wait
        // happens INSIDE the task instead of before the insert (which would
        // suspend the actor mid-registration and reopen the race — Jules
        // review, PR #1907).
        let coalescingKey = "display-preview:" + ThumbnailDiskCache.cacheKey(for: url)
        if let existing = inFlight[coalescingKey] {
            return await existing.value
        }

        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let isRaw = asset.isRaw
        let task = Task.detached(priority: .utility) { () -> Data? in
            await self.acquireDecodeSlot()
            let result = Self.produceDisplayPreview(url: url, scope: scope, isRaw: isRaw)
            await self.releaseDecodeSlot()
            return result
        }
        inFlight[coalescingKey] = task
        let result = await task.value
        // Conditional removal — same `cancelAll()` re-registration edge as
        // the two `load` paths in ThumbnailLoader.swift (Jules, PR #1911).
        if inFlight[coalescingKey] == task {
            inFlight.removeValue(forKey: coalescingKey)
        }
        return result
    }

    /// The synchronous produce path: serve the fresh cached tier, gate on
    /// visual edits, else generate from the embedded preview and persist.
    /// Runs on a detached task under the decode-slot gate.
    private nonisolated static func produceDisplayPreview(
        url: URL, scope: URL, isRaw: Bool
    ) -> Data? {
        let accessing = scope.startAccessingSecurityScopedResource()
        defer { if accessing { scope.stopAccessingSecurityScopedResource() } }

        let previewURL = MapleSidecarPaths.previewURL(for: url)
        if let cached = freshDisplayPreviewData(previewURL: previewURL, assetURL: url) {
            return cached
        }
        if sidecarHasVisualEdits(assetURL: url) {
            return nil
        }
        guard let data = displayPreviewJPEG(at: url, isRaw: isRaw) else { return nil }
        try? FileManager.default.createDirectory(
            at: previewURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: previewURL, options: .atomic)
        return data
    }

    /// Refresh BOTH render-derived artifacts — the 256 px browse thumbnail
    /// and the 1600 px display preview — from one rendered frame. The render-
    /// publish paths (`EditSession+Render`, the #1879 GPU-exit readback) call
    /// this so the two tiers stay in lock-step: an edited photo's Preview
    /// swap must show the same EDITED pixels its thumbnail does.
    public func updateDerivedImagesFromRender(_ rendered: CIImage, for assetURL: URL) async {
        await updateThumbnailFromRender(rendered, for: assetURL)
        await updateDisplayPreviewFromRender(rendered, for: assetURL)
    }

    /// Overwrite the on-disk display preview for `assetURL` with one rendered
    /// from a CIImage — the display-tier sibling of
    /// `updateThumbnailFromRender`, called from the same render-publish paths
    /// so an edited photo's Preview swap shows the EDITED pixels, not the
    /// camera original.
    public func updateDisplayPreviewFromRender(_ rendered: CIImage, for assetURL: URL) async {
        let target = Self.displayPreviewLongEdge
        let extent = rendered.extent
        let longEdge = max(extent.width, extent.height)
        let scale = longEdge > 0 ? min(1.0, target / longEdge) : 1.0
        let scaled = rendered.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let data = Self.jpegData(from: scaled, ctx: ctx) else { return }
        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)
        try? FileManager.default.createDirectory(
            at: previewURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: previewURL, options: .atomic)
    }

    /// A sidecar may legitimately be a little newer than the preview the
    /// editor wrote for it: the render-publish path writes the tier per
    /// refine render, while the sidecar lands on the 750 ms debounced
    /// autosave — so on editor exit the sidecar's mtime trails the preview's
    /// by up to a couple of seconds. Within this window the preview is the
    /// developed render OF that sidecar, not a stale artifact. An externally
    /// synced edit (the case the staleness check below exists for) arrives
    /// minutes-to-days later.
    private static let sidecarAutosaveSlack: TimeInterval = 10

    /// Bytes of the cached display preview when it is fresh; nil on a miss
    /// or a stale entry. Fresh means:
    ///   - at least as new as the asset file, AND
    ///   - not superseded by a visually-edited sidecar written after it
    ///     (beyond the autosave slack) — e.g. an edit synced from another
    ///     device while a camera-original preview sits on disk. Serving that
    ///     preview would swap camera-original pixels over an edited
    ///     thumbnail (Copilot review, PR #1907). Suppressing the swap keeps
    ///     the thumbnail — never wrong, just lower-res — until the render
    ///     paths write a developed tier.
    private nonisolated static func freshDisplayPreviewData(
        previewURL: URL, assetURL: URL
    ) -> Data? {
        let fm = FileManager.default
        guard
            let previewMtime = (try? fm.attributesOfItem(atPath: previewURL.path))?[
                .modificationDate
            ] as? Date
        else { return nil }
        let assetMtime = (try? fm.attributesOfItem(atPath: assetURL.path))?[
            .modificationDate
        ] as? Date
        guard assetMtime.map({ previewMtime >= $0 }) ?? true else { return nil }

        let sidecarMtime = (try? fm.attributesOfItem(
            atPath: SidecarPath.sidecarURL(for: assetURL).path))?[
            .modificationDate
        ] as? Date
        let supersededByEdit = sidecarMtime.map {
            $0.timeIntervalSince(previewMtime) > sidecarAutosaveSlack
                && sidecarHasVisualEdits(assetURL: assetURL)
        } ?? false
        guard !supersededByEdit else { return nil }

        return try? Data(contentsOf: previewURL)
    }

    /// True when a sidecar exists next to `assetURL` and parses to a model
    /// with visual (non-WB) adjustments. An unparseable sidecar counts as
    /// edited — serving camera-original pixels over an unknown edit state is
    /// the failure mode this gate exists to prevent.
    private nonisolated static func sidecarHasVisualEdits(assetURL: URL) -> Bool {
        let sidecar = SidecarPath.sidecarURL(for: assetURL)
        guard let data = try? Data(contentsOf: sidecar) else { return false }
        guard let (model, _) = try? XMPParser.parse(data: data) else { return true }
        return model.isVisuallyEditedBeyondWhiteBalance
    }

    /// Extract the display-preview JPEG via ImageIO. RAWs use the embedded
    /// camera preview ONLY (`FromImageIfAbsent: false` — an Apple-RAW decode
    /// renders differently from the Maple pipeline and must never be
    /// persisted as this asset's preview). Non-RAW bitmaps decode exactly,
    /// so when their embedded thumb is too small to be useful they
    /// synthesize one from the full image instead.
    private nonisolated static func displayPreviewJPEG(at url: URL, isRaw: Bool) -> Data? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let targetPx = Int(displayPreviewLongEdge)
        let embeddedOpts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: false,
            kCGImageSourceCreateThumbnailFromImageIfAbsent: false,
            kCGImageSourceThumbnailMaxPixelSize: targetPx,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCache: false,
        ]
        let embedded = CGImageSourceCreateThumbnailAtIndex(src, 0, embeddedOpts as CFDictionary)
        let usable: CGImage? = {
            if let embedded,
                max(embedded.width, embedded.height) >= minUsefulEmbeddedLongEdge {
                return embedded
            }
            guard !isRaw else { return nil }
            let decodeOpts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: targetPx,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCache: false,
            ]
            return CGImageSourceCreateThumbnailAtIndex(src, 0, decodeOpts as CFDictionary)
        }()
        guard let cg = usable else { return nil }
        return jpegData(from: CIImage(cgImage: cg), ctx: displayPreviewCIContext)
    }
}
