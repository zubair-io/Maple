// ThumbnailLoader.swift — view-layer facing glue that returns AVIF bytes for
// a given asset URL, consulting ThumbnailDiskCache first and only falling
// through to PipelineRenderer on a miss.
//
// The UI cell (see Maple/Views/BrowseGrid.swift) calls `load(for:)` on cell
// appear; the loader cancels the render task on cell disappear so fast-scroll
// doesn't burn CPU on off-screen rows.
//
// Encoding / sizing per spec § 03 (thumbnail AVIF migration):
//   - target long edge = 256 px
//   - AVIF quality     = ThumbnailEncoder.quality (0.5)
//   - sRGB colourspace

import Foundation
import AVFoundation
import CoreImage
import ImageIO
import os

private let logger = Logger(subsystem: "app.justmaple.aperture", category: "ThumbnailLoader")

// MARK: - ThumbnailLoader

public actor ThumbnailLoader {
    public static let shared = ThumbnailLoader()

    /// Reused CIContext — creating one per call is expensive and pins GPU
    /// memory for no reason. (Internal, not private: the display-preview
    /// tier in `ThumbnailLoader+DisplayPreview.swift` shares it.)
    let ctx = CIContext()

    /// Shared CIContext for every static encode path (`posterAVIF`,
    /// `embeddedPreviewAVIF`, the Rust-develop and render-from-bytes
    /// fallbacks). `CIContext` is heavyweight to allocate and thread-safe to
    /// share, so the static encoders reuse this one instance instead of
    /// minting a new context on every call (one per grid cell on scroll,
    /// otherwise).
    private static let staticEncodeCIContext = CIContext()

    /// Cap on concurrent thumbnail generations. The previous value (3) was
    /// tuned for the old Rust-develop thumbnail path (~350 ms each, CPU-
    /// bound). The new embedded-preview path via `CGImageSourceCreate
    /// ThumbnailAtIndex` is ~5–50 ms per image and mostly IO-bound, so it
    /// can run much wider. Sized to the machine: half of the logical cores,
    /// minimum 4, maximum 12. On an M4 Max (16 cores) that's 8; on a base
    /// M1 (8 cores) it's 4. The Rust fallback slow path piggy-backs on the
    /// same gate but runs rarely enough (only for RAWs without embedded
    /// previews) that it doesn't need a separate cap.
    private static let maxConcurrentDecodes: Int = {
        let cores = ProcessInfo.processInfo.activeProcessorCount
        return max(4, min(12, cores / 2))
    }()
    private var activeDecodes = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    /// In-flight loads, keyed by `cacheKey(for: assetURL)`. When two grid
    /// cells request the same thumbnail simultaneously (happens on scroll /
    /// layout churn), the second call awaits the first's Task instead of
    /// starting a duplicate decode. Major CPU win on large folders.
    /// (Internal, not private: the display-preview tier in
    /// `ThumbnailLoader+DisplayPreview.swift` coalesces through the same map
    /// under a `"display-preview:"`-namespaced key.)
    var inFlight: [String: Task<Data?, Never>] = [:]

    public init() {}

    // MARK: - Concurrency gate

    /// Wait until a decode slot is available; call `releaseDecodeSlot()`
    /// exactly once after the FFI call completes. (Internal, not fileprivate:
    /// the display-preview tier in `ThumbnailLoader+DisplayPreview.swift`
    /// shares the same gate.)
    func acquireDecodeSlot() async {
        if activeDecodes < Self.maxConcurrentDecodes {
            activeDecodes += 1
            return
        }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            waiters.append(cont)
        }
        activeDecodes += 1
    }

    func releaseDecodeSlot() {
        activeDecodes -= 1
        if !waiters.isEmpty {
            let next = waiters.removeFirst()
            next.resume()
        }
    }

    // MARK: - Public API

    /// Look up a thumbnail in the disk cache; on miss, render via the Rust
    /// pipeline, downscale, AVIF-encode, persist via the disk cache, and
    /// return the bytes. Returns `nil` only when the render itself fails.
    public func load(for assetURL: URL) async -> Data? {
        await load(for: assetURL, scopeParentURL: nil)
    }

    /// Overload that accepts an explicit bookmark-resolved scope parent URL.
    /// Preferred over the URL-only entry point — claiming scope on a
    /// reconstructed `assetURL.deletingLastPathComponent()` is a silent
    /// no-op because that URL carries no scope token, so the Rust FFI read
    /// fails with EPERM under the sandbox.
    public func load(for assetURL: URL, scopeParentURL: URL?) async -> Data? {
        // 1. Fast path: cached AVIF bytes.
        if let cached = await ThumbnailDiskCache.shared.thumbnailData(for: assetURL) {
            return cached
        }

        // 2. Coalesce duplicate requests. If a prior call for the same URL
        //    is still in-flight, await its Task instead of starting a new
        //    one. Eliminates the ~30% wasted CPU during grid scroll+layout
        //    churn where the same cell requests a thumb twice. The check +
        //    task creation + map insert below run with NO intervening
        //    `await`, so no second caller can interleave and start a
        //    duplicate; the decode-slot wait happens INSIDE the task (an
        //    `await acquireDecodeSlot()` here would suspend the actor
        //    mid-registration and reopen the race — the Jules finding on
        //    PR #1907's display-preview path, same fix).
        let coalescingKey = ThumbnailDiskCache.cacheKey(for: assetURL)
        if let existing = inFlight[coalescingKey] {
            return await existing.value
        }

        // 3. Miss: invoke the Rust pipeline on a background-priority task.
        //    Scope claim MUST be on the bookmark-resolved ancestor — that's
        //    what `scopeParentURL` is for. The claim is held for the full
        //    span of the FFI call so the mmap inside `std::fs::read` sees
        //    an active scope.
        let scope = scopeParentURL ?? assetURL.deletingLastPathComponent()
        let task = Task.detached(priority: .utility) { () -> Data? in
            // Gate concurrent thumbs so the browse grid doesn't fire N
            // decodes in parallel when the user opens a big folder.
            await self.acquireDecodeSlot()
            let result = await Self.produceThumbnail(assetURL: assetURL, scope: scope)
            await self.releaseDecodeSlot()
            return result
        }
        inFlight[coalescingKey] = task
        let result = await task.value
        // Conditional removal: `cancelAll()` may have cleared the map and a
        // NEWER task may already be registered under this key — evicting it
        // here would silently break coalescing for that asset until the new
        // task completes (Jules review, PR #1911).
        if inFlight[coalescingKey] == task {
            inFlight.removeValue(forKey: coalescingKey)
        }
        return result
    }

    /// The produce path behind the URL-keyed `load`: asset-relative
    /// `.maple/thumbs`, video poster, stub/audio bail, embedded-preview fast
    /// path, Rust-develop slow path. Runs on a detached task under the
    /// decode-slot gate, with the security scope claimed for its full span.
    private nonisolated static func produceThumbnail(assetURL: URL, scope: URL) async -> Data? {
        let accessing = scope.startAccessingSecurityScopedResource()
        defer { if accessing { scope.stopAccessingSecurityScopedResource() } }

        // ASSET-RELATIVE .maple/thumbs — render-time derivatives written
        // next to the asset (e.g. a pano in Panoramas/) are found even when
        // the singleton cache is configured for a different (parent) folder.
        // (#1365.) The disk-cache hit at step 1 short-circuits before this,
        // so RAWs in their own folder never pay for it.
        let relThumb = MapleSidecarPaths.thumbURL(for: assetURL)
        if FileManager.default.fileExists(atPath: relThumb.path),
            let data = try? Data(contentsOf: relThumb)
        {
            await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
            return data
        }

        // VIDEO PATH — extract a poster frame via AVFoundation (#1642).
        // Checked AFTER the .maple/thumbs cache lookup above so a pre-written
        // poster is served from disk without touching AVFoundation again.
        // Short-circuits BEFORE CGImageSourceCreateThumbnailAtIndex so video
        // container bytes are never fed to ImageIO or libraw.
        if SidecarPath.isVideo(assetURL) {
            guard let data = await posterAVIF(at: assetURL) else {
                logger.warning("video poster extraction failed for \(assetURL.lastPathComponent, privacy: .public)")
                return nil
            }
            logger.debug("video poster extracted for \(assetURL.lastPathComponent, privacy: .public)")
            await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
            return data
        }

        // STUB / AUDIO PATH — metadata-only formats with no decode path
        // at all (eip/braw/afphoto/ai stub images, mp3/wav/m4a/aac audio;
        // #1835). No thumbnail is generated — the grid shows filename/
        // size/date with a generic stub badge instead. Short-circuits
        // BEFORE the embedded-preview / Rust-develop paths below so these
        // never reach ImageIO or libraw.
        let ext = assetURL.pathExtension.lowercased()
        if StubExtensions.all.contains(ext) || AudioExtensions.all.contains(ext) {
            return nil
        }

        // FAST PATH — read the embedded JPEG preview via ImageIO.
        // DNGs (and most camera RAWs) carry a ~1920 px preview; ImageIO
        // extracts + resamples it at the target size in 5-50 ms per
        // image vs 300-500 ms for a full Rust develop.
        let t0 = Date()
        if let data = embeddedPreviewAVIF(at: assetURL) {
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            logger.debug("thumb fast-path \(assetURL.lastPathComponent, privacy: .public) \(ms)ms")
            await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
            return data
        }
        logger.warning("thumb fast-path MISS for \(assetURL.lastPathComponent, privacy: .public) — falling through to slow path")

        // SLOW PATH — no embedded preview. Non-RAW bitmaps (imported JPEG/
        // PNG/HEIF, stitched pano PNGs) already carry demosaiced sRGB /
        // Display-P3 pixels, so they decode via ImageIO directly instead of
        // the RAW developer — `PipelineRenderer.render(rawPath:)` only
        // understands camera RAW containers and throws on these, which used
        // to surface as a blank grey grid tile (#1366). Everything else
        // (the actual `RAWExtensions.all` set, plus unrecognised
        // extensions — same "assume RAW" default as `AssetRef.isRaw`) keeps
        // the full develop + downscale path.
        if NonRawImageExtensions.all.contains(ext) {
            guard let data = nonRawSlowPathAVIF(at: assetURL) else {
                logger.warning("non-RAW slow-path decode failed for \(assetURL.lastPathComponent, privacy: .public)")
                return nil
            }
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            logger.debug("thumb non-RAW slow-path \(assetURL.lastPathComponent, privacy: .public) \(ms)ms")
            await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
            return data
        }

        do {
            let image = try PipelineRenderer.render(rawPath: assetURL, quality: .preview)
            guard let data = encodeThumbnail(image, ctx: staticEncodeCIContext) else {
                logger.warning("AVIF encode failed for \(assetURL.lastPathComponent, privacy: .public)")
                return nil
            }
            await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
            return data
        } catch {
            logger.error("pipeline render failed for \(assetURL.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Cancel every in-flight thumbnail load. Called by `AppShell` on folder
    /// switch so stale tasks don't keep computing against the old folder's
    /// files while the grid now shows different ones.
    public func cancelAll() {
        for task in inFlight.values { task.cancel() }
        inFlight.removeAll()
        // Drain waiters so anyone parked on the decode slot semaphore
        // unblocks (they'll return nil when their Task sees cancellation).
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
        activeDecodes = 0
    }

    /// Shrink the in-memory cache to roughly 25% of capacity. Called on
    /// macOS memory pressure / iOS UIApplication.didReceiveMemoryWarning.
    public func handleMemoryPressure() async {
        await ThumbnailDiskCache.shared.shrinkMemCache(to: 25)
    }

    /// Overwrite the on-disk thumbnail for `assetURL` with one rendered from
    /// a CIImage — used by `EditSession` after a develop render completes so
    /// the grid reflects the user's edits on the next browse.
    public func updateThumbnailFromRender(_ rendered: CIImage, for assetURL: URL) async {
        let targetLongEdge = ThumbnailDiskCache.defaultThumbSize.width
        let extent = rendered.extent
        let longEdge = max(extent.width, extent.height)
        let scale = longEdge > 0 ? min(1.0, targetLongEdge / longEdge) : 1.0
        let scaled = rendered.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let data = Self.thumbnailData(from: scaled, ctx: ctx) else { return }
        await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
    }

    /// Read the embedded JPEG preview from a file and resample + re-encode it
    /// to AVIF via ImageIO. Returns nil if the file has no extractable
    /// thumbnail (very rare for modern RAWs + regular JPEGs).
    private static func embeddedPreviewAVIF(at url: URL) -> Data? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let targetPx = Int(ThumbnailDiskCache.defaultThumbSize.width * 2) // 2x for Retina
        let opts: [CFString: Any] = [
            // Prefer an existing embedded thumbnail; fall back to a new one
            // generated from the full image if none is present.
            kCGImageSourceCreateThumbnailFromImageAlways: false,
            kCGImageSourceCreateThumbnailFromImageIfAbsent: true,
            kCGImageSourceThumbnailMaxPixelSize: targetPx,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCache: false,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
            return nil
        }
        // Encode to AVIF at spec quality via CIContext (reuses GPU path).
        let ci = CIImage(cgImage: cg)
        return thumbnailData(from: ci, ctx: staticEncodeCIContext)
    }

    /// Encode a CIImage to AVIF at the spec quality (`ThumbnailEncoder.quality`).
    /// (Internal, not private: shared by `ThumbnailLoader+DisplayPreview.swift`.)
    static func thumbnailData(from ci: CIImage, ctx: CIContext) -> Data? {
        return ThumbnailEncoder.encode(ci, ctx: ctx)
    }

    /// Sourceless entry point — for assets without a filesystem URL (PhotoKit,
    /// SelfHosted). Order of attempts:
    ///   1. Disk cache hit on the asset's stable id.
    ///   2. `source.thumb(for:)` — server-rendered or PhotoKit fast path.
    ///   3. Render-from-bytes fallback: `bytesProvider` → `PipelineRenderer.render(rawBytes:hint:)`
    ///      → JPEG q=0.82 at 256 px long edge → cache.
    ///
    /// Returns `nil` when no path produced bytes (network down + no fallback,
    /// renderer failure, etc.).
    public func load(
        for asset: AssetRef,
        from source: (any ImageSource)?
    ) async -> Data? {
        // Determine cache key. Sourceless assets prefer their stable id;
        // filesystem-shaped assets fall through to the URL-keyed overload.
        if let url = asset.primaryURL {
            return await load(for: url, scopeParentURL: asset.scopeParentURL)
        }
        let key = asset.stableID ?? asset.displayName

        // 1. Disk-cache hit.
        if let cached = await ThumbnailDiskCache.shared.thumbnailData(forKey: key) {
            return cached
        }

        // 2. Coalesce duplicate requests, same no-await-between-check-and-
        //    insert contract as the URL-keyed overload above (this path
        //    previously had no coalescing at all: two cells requesting the
        //    same PhotoKit/SelfHosted asset each ran their own fetch +
        //    render). Namespaced so a stable id can never collide with the
        //    URL overload's basename-hash keys.
        let coalescingKey = "sourceless:" + key
        if let existing = inFlight[coalescingKey] {
            return await existing.value
        }

        let stableID = asset.stableID
        let displayName = asset.displayName
        let provider = asset.bytesProvider
        let hint = asset.hintExtension ?? ""
        let task = Task.detached(priority: .utility) { () -> Data? in
            // Source-provided thumbnail (server-rendered / PhotoKit fast
            // path). Network-bound, so not decode-slot gated. Reconstruct an
            // ImageRef the source can dispatch on — only id+displayName are
            // needed; URL is unused for sourceless adapters.
            if let source, let stableID {
                let ref = ImageRef(id: stableID, displayName: displayName)
                if let bytes = (try? await source.thumb(for: ref)) ?? nil {
                    await ThumbnailDiskCache.shared.storeThumbnailData(bytes, forKey: key)
                    return bytes
                }
            }

            // Fallback: pull RAW bytes through the asset's provider, render
            // via the Rust pipeline, encode AVIF, persist — under the
            // decode-slot gate (acquired INSIDE the task; see the URL-keyed
            // overload for why).
            guard let provider else { return nil }
            await self.acquireDecodeSlot()
            let result: Data? = await {
                do {
                    let bytes = try await provider()
                    let image = try PipelineRenderer.render(
                        rawBytes: bytes, hint: hint, quality: .preview)
                    guard let data = Self.encodeThumbnail(image, ctx: Self.staticEncodeCIContext) else {
                        return nil
                    }
                    await ThumbnailDiskCache.shared.storeThumbnailData(data, forKey: key)
                    return data
                } catch {
                    return nil
                }
            }()
            await self.releaseDecodeSlot()
            return result
        }
        inFlight[coalescingKey] = task
        let result = await task.value
        // Conditional removal — same `cancelAll()` re-registration edge as
        // the URL-keyed overload above.
        if inFlight[coalescingKey] == task {
            inFlight.removeValue(forKey: coalescingKey)
        }
        return result
    }

    // MARK: - Helpers

    /// Downscale the pipeline-produced RGB buffer to the thumbnail long-edge
    /// and AVIF-encode at `ThumbnailEncoder.quality`.
    private static func encodeThumbnail(_ image: MapleImageData, ctx: CIContext) -> Data? {
        guard image.pixels.count == image.width * image.height * 3 else { return nil }

        let bitmapInfo = CGImageAlphaInfo.none.rawValue
        let copy = image.pixels
        guard let dp = CGDataProvider(data: copy as CFData) else { return nil }
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let cgImg = CGImage(
            width: image.width, height: image.height,
            bitsPerComponent: 8, bitsPerPixel: 24,
            bytesPerRow: image.width * 3,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
            provider: dp,
            decode: nil,
            shouldInterpolate: true,
            intent: .defaultIntent
        ) else { return nil }

        var ci = CIImage(cgImage: cgImg)
        // Downscale to 256 px long edge.
        let target = ThumbnailDiskCache.defaultThumbSize.width
        let longEdge = CGFloat(max(image.width, image.height))
        if longEdge > target {
            let scale = target / longEdge
            ci = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        return ThumbnailEncoder.encode(ci, ctx: ctx)
    }

    /// Extract a poster frame from a video file using AVFoundation (#1642).
    ///
    /// Requests a frame at 1 second in; if the asset is shorter, the requested
    /// time is clamped to the asset duration so the generator returns the last
    /// available frame instead of failing. Returns AVIF bytes downscaled to
    /// `ThumbnailDiskCache.defaultThumbSize` long edge at
    /// `ThumbnailEncoder.quality`, or nil if AVFoundation cannot read the
    /// file (unsupported codec, missing file, etc.).
    ///
    /// Uses the async `AVAssetImageGenerator.image(at:)` (iOS 16 / macOS 13+),
    /// NOT the synchronous `copyCGImage` — the latter blocks the calling thread
    /// while it decodes. Generating several posters at once (grid scroll) on the
    /// synchronous API would block multiple cooperative-pool threads and starve
    /// the pool. The async API suspends instead, freeing the thread for other work.
    private static func posterAVIF(at url: URL) async -> Data? {
        let asset = AVAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        // Apply the track's preferred display transform so portrait clips
        // (e.g. iPhone portrait video) are not served sideways.
        generator.appliesPreferredTrackTransform = true
        // Cap decode resolution: request at most 2× the thumbnail target to get a
        // sharp downscale without decoding the full frame at native resolution.
        let target = ThumbnailDiskCache.defaultThumbSize
        generator.maximumSize = CGSize(width: target.width * 2, height: target.height * 2)

        // Prefer 1s in. For clips shorter than 1s, clamp to the asset duration so
        // the generator returns the final frame rather than failing the request.
        let oneSecond = CMTime(seconds: 1, preferredTimescale: 600)
        let requested: CMTime
        if let duration = try? await asset.load(.duration), duration.isNumeric, duration < oneSecond {
            requested = duration
        } else {
            requested = oneSecond
        }

        guard let cg = try? await generator.image(at: requested).image else { return nil }

        // Encode via the shared CIContext + JPEG helper as the image thumbnail path.
        let ci = CIImage(cgImage: cg)
        let extent = ci.extent
        let longEdge = max(extent.width, extent.height)
        let scaled: CIImage = longEdge > target.width
            ? ci.transformed(by: CGAffineTransform(
                scaleX: target.width / longEdge,
                y: target.width / longEdge))
            : ci
        return thumbnailData(from: scaled, ctx: staticEncodeCIContext)
    }
}
