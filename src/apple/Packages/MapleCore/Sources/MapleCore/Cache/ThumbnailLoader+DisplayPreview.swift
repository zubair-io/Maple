// ThumbnailLoader+DisplayPreview.swift — the `.maple/previews` 1600 px
// display tier behind the Preview screen's thumbnail → display-res swap
// (spec §3 of docs/superpowers/specs/2026-07-06-fast-preview-and-phone-card-
// editor-design.md, slice A1).
//
// Split from ThumbnailLoader.swift for the file-size budget; shares the
// actor's decode-slot gate and in-flight coalescing map. Does NOT share the
// 256px thumbnail tier's encoder: the thumbnail AVIF migration switched that
// tier to `ThumbnailEncoder` (AVIF), but `.maple/previews/` stays JPEG, so
// this file keeps its own independent JPEG quality constant + encoder below.

import CoreImage
import Foundation
import ImageIO

extension ThumbnailLoader {
    /// JPEG quality for the display-preview tier — independent of the 256px
    /// thumbnail tier's `ThumbnailEncoder.quality` (AVIF scale). This tier is
    /// out of scope for the thumbnail AVIF migration and stays JPEG.
    private static let previewJpegQuality: CGFloat = 0.82

    /// Encode a CIImage to JPEG at `previewJpegQuality`. Local to the
    /// display-preview tier — NOT the same encoder as the (now AVIF) 256px
    /// thumbnail tier in ThumbnailLoader.swift.
    private static func previewJpegData(from ci: CIImage, ctx: CIContext) -> Data? {
        return ctx.jpegRepresentation(
            of: ci,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption:
                        previewJpegQuality]
        )
    }

    /// Long-edge target for the display-preview tier at
    /// `MapleSidecarPaths.previewURL` (`.maple/previews/
    /// <sha256prefix16(basename)>_1600.jpg`). 1600 is the established
    /// convention: the pano stitcher writes it at stitch time (#1365) and
    /// `EditSession` cold-open seeding reads it — the Preview screen's
    /// display tier reuses the same artifact.
    public static let displayPreviewLongEdge: CGFloat = 1_600

    /// Render-semantics version of the display-preview tier (#1976). The JPEG
    /// filename is a cross-consumer contract, so staleness rides the sibling
    /// `<key>_1600.v` marker (`MapleSidecarPaths.previewVersionURL`) instead
    /// of the key: a preview with a missing or older marker is treated as a
    /// miss and regenerated (embedded JPEG) or suppressed (visually edited —
    /// the editor's render refresh repopulates it). v1 introduces the marker;
    /// every pre-marker file is stale by definition, which retires the
    /// previews persisted from the #1976 cyan-anchored renders.
    public static let displayPreviewTierVersion: UInt32 = 1

    /// Whether the display preview for `assetURL` carries the current tier
    /// version marker. Missing / unreadable / older markers read as stale.
    public nonisolated static func displayPreviewMarkerIsCurrent(for assetURL: URL) -> Bool {
        let markerURL = MapleSidecarPaths.previewVersionURL(for: assetURL)
        guard let text = try? String(contentsOf: markerURL, encoding: .utf8),
            let version = UInt32(text.trimmingCharacters(in: .whitespacesAndNewlines))
        else { return false }
        return version >= displayPreviewTierVersion
    }

    /// Stamp the current tier version next to a just-written display preview.
    nonisolated static func writeDisplayPreviewMarker(for assetURL: URL) {
        let markerURL = MapleSidecarPaths.previewVersionURL(for: assetURL)
        try? "\(displayPreviewTierVersion)".write(
            to: markerURL, atomically: true, encoding: .utf8)
    }

    // MARK: - Edited/developed preview tier (#2009)

    /// Sidecar-state epoch used by the edited-preview freshness marker: the
    /// XMP sidecar's own mtime as a Unix timestamp, or `0` when no sidecar
    /// exists yet — in practice this only surfaces for an asset whose
    /// editor has never been opened (the as-shot WB seed writes a sidecar
    /// on first open; see `sidecarHasVisualEdits`'s doc).
    private nonisolated static func sidecarStateEpoch(for assetURL: URL) -> TimeInterval {
        let sidecar = SidecarPath.sidecarURL(for: assetURL)
        guard
            let mtime = (try? FileManager.default.attributesOfItem(atPath: sidecar.path))?[
                .modificationDate
            ] as? Date
        else { return 0 }
        return mtime.timeIntervalSince1970
    }

    /// Whether the local edited/developed preview for `assetURL` still
    /// matches the CURRENT edit sidecar, tolerating `sidecarAutosaveSlack`
    /// (below) of drift between when the render-publish path captured the
    /// sidecar's state and when the 750 ms debounced autosave actually
    /// lands on disk: the render-publish write reads whatever the sidecar
    /// says AT THAT MOMENT, which routinely trails the live in-memory model
    /// by up to the debounce window, so the autosave landing a beat later
    /// FOR THE SAME EDIT must not read as a sidecar change. A sidecar mtime
    /// that moved by more than the slack (a real new edit, one synced from
    /// another device, or a revert) still invalidates (Jules review, PR
    /// #2013 — the original exact-equality check falsely invalidated the
    /// preview it had just written on every edit). Distinct from
    /// `displayPreviewMarkerIsCurrent`, which tracks the display-preview
    /// tier's render-SEMANTICS version, not sidecar edit state.
    public nonisolated static func editedPreviewMarkerIsCurrent(for assetURL: URL) -> Bool {
        let markerURL = MapleSidecarPaths.editedPreviewMarkerURL(for: assetURL)
        guard let text = try? String(contentsOf: markerURL, encoding: .utf8),
            let recorded = TimeInterval(text.trimmingCharacters(in: .whitespacesAndNewlines))
        else { return false }
        let delta = sidecarStateEpoch(for: assetURL) - recorded
        return delta >= 0 && delta <= sidecarAutosaveSlack
    }

    /// Stamp the CURRENT sidecar-state epoch next to a just-written edited
    /// preview, so a later read can tell whether the sidecar has since
    /// changed (beyond `sidecarAutosaveSlack`).
    nonisolated static func writeEditedPreviewMarker(for assetURL: URL) {
        let markerURL = MapleSidecarPaths.editedPreviewMarkerURL(for: assetURL)
        try? String(format: "%.6f", sidecarStateEpoch(for: assetURL)).write(
            to: markerURL, atomically: true, encoding: .utf8)
    }

    /// Delete the local edited-render preview + its freshness marker for
    /// `assetURL`, if present. A no-op when neither file exists.
    nonisolated static func removeEditedPreview(for assetURL: URL) {
        let fm = FileManager.default
        try? fm.removeItem(at: MapleSidecarPaths.editedPreviewURL(for: assetURL))
        try? fm.removeItem(at: MapleSidecarPaths.editedPreviewMarkerURL(for: assetURL))
    }

    /// Bytes of the local edited/developed preview when it's fresh — nil on
    /// a miss (never rendered) or a missing/unreadable file. A STALE marker
    /// (present but no longer matching the current sidecar — see
    /// `editedPreviewMarkerIsCurrent`) is a real orphan: the sidecar moved on
    /// since this render was captured, so it's cleaned up right here rather
    /// than left for `cache-gc.ts`'s backstop sweep to eventually find
    /// (#2009). A missing marker (never rendered, or already cleaned up) is
    /// a no-op remove.
    nonisolated static func freshEditedPreviewData(for assetURL: URL) -> Data? {
        guard editedPreviewMarkerIsCurrent(for: assetURL) else {
            removeEditedPreview(for: assetURL)
            return nil
        }
        return try? Data(contentsOf: MapleSidecarPaths.editedPreviewURL(for: assetURL))
    }

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

        // #2009: the local edited/developed render takes precedence when its
        // sidecar-state marker is current — it reflects the ACTUAL pixels
        // this sidecar renders to (Maple's own pipeline, distinct from the
        // camera JPEG the canonical tier below is seeded from), and the
        // 256px browse thumbnail already shows those same developed pixels.
        if let edited = freshEditedPreviewData(for: url) {
            return edited
        }

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
        writeDisplayPreviewMarker(for: url)
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

    /// Overwrite the on-disk EDITED/developed preview for `assetURL` with one
    /// rendered from a CIImage — the display-tier sibling of
    /// `updateThumbnailFromRender`, called from the same render-publish paths
    /// so an edited photo's Preview swap shows the EDITED pixels, not the
    /// camera original.
    ///
    /// Writes `MapleSidecarPaths.editedPreviewURL`, NOT `previewURL` (#2009):
    /// `previewURL` is the shared, cross-consumer camera-original contract
    /// the Self-Hosted API's describe/OCR (VLM) pipeline reads — an earlier
    /// design draft that wrote developed pixels there was a confirmed
    /// correctness-and-privacy bug, not just a caching one. This tier is
    /// LOCAL-ONLY.
    public func updateDisplayPreviewFromRender(_ rendered: CIImage, for assetURL: URL) async {
        let target = Self.displayPreviewLongEdge
        let extent = rendered.extent
        let longEdge = max(extent.width, extent.height)
        let scale = longEdge > 0 ? min(1.0, target / longEdge) : 1.0
        let scaled = rendered.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let data = Self.previewJpegData(from: scaled, ctx: ctx) else { return }
        let editedURL = MapleSidecarPaths.editedPreviewURL(for: assetURL)
        try? FileManager.default.createDirectory(
            at: editedURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: editedURL, options: .atomic)
        Self.writeEditedPreviewMarker(for: assetURL)
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
        // #1976: a missing/old tier-version marker means the file may have
        // been persisted from a render with since-fixed semantics — treat
        // as a miss so it regenerates (or is suppressed for edited photos).
        guard displayPreviewMarkerIsCurrent(for: assetURL) else { return nil }
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
        return previewJpegData(from: CIImage(cgImage: cg), ctx: displayPreviewCIContext)
    }
}
