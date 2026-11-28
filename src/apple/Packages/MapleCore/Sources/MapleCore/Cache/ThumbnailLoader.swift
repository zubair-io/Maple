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

import AVFoundation
import CoreImage
import Foundation
import ImageIO
import os

let thumbnailLoaderLogger = Logger(subsystem: "app.justmaple.aperture", category: "ThumbnailLoader")

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
  static let staticEncodeCIContext = CIContext()

  /// Cap on concurrent thumbnail generations. The previous value (3) was
  /// tuned for the old Rust-develop thumbnail path (~350 ms each, CPU-
  /// bound). The new embedded-preview path via `CGImageSourceCreate
  /// ThumbnailAtIndex` is ~5–50 ms per image and mostly IO-bound, so it
  /// can run much wider. Sized to the machine: half of the logical cores,
  /// minimum 4, maximum 12. On an M4 Max (16 cores) that's 8; on a base
  /// M1 (8 cores) it's 4. Full develops use the lanes below instead.
  static let maxConcurrentDecodes: Int = {
    let cores = ProcessInfo.processInfo.activeProcessorCount
    return max(4, min(12, cores / 2))
  }()
  let decodeSlots = BoundedAsyncSemaphore(value: maxConcurrentDecodes)
  // One grid develop at a time, plus one permit reserved so a photo being opened never waits behind the grid.
  let gridDevelopLane = BoundedAsyncSemaphore(value: 1)
  let interactiveDevelopLane = BoundedAsyncSemaphore(value: 1)
  var slotlessProducers: Set<UUID> = []
  /// Sourceless originals whose download decoded to nothing: a retry asks the
  /// server again but never downloads them a second time.
  var unrenderableSourcelessKeys: Set<String> = []

  /// Cap on concurrent fetches from a source whose thumbnails are
  /// latency-bound network reads (`ImageSource.thumbnailsAreLatencyBound`,
  /// #6008), which would otherwise queue behind the decode gate. A
  /// render-from-bytes fallback from such a source also takes a decode slot.
  public static let maxConcurrentSourceFetches = 16
  let sourceFetchSlots = BoundedAsyncSemaphore(value: maxConcurrentSourceFetches)

  enum ProducerGate {
    case decode
    case sourceFetch
  }

  func slots(for gate: ProducerGate) -> BoundedAsyncSemaphore {
    switch gate {
    case .decode: decodeSlots
    case .sourceFetch: sourceFetchSlots
    }
  }

  /// In-flight loads, keyed by `ThumbnailDiskCache.memoryKey(for:)`. When two grid
  /// cells request the same thumbnail simultaneously (happens on scroll /
  /// layout churn), the second call awaits the first's Task instead of
  /// starting a duplicate decode. Major CPU win on large folders.
  /// (Internal, not private: the display-preview tier in
  /// `ThumbnailLoader+DisplayPreview.swift` coalesces through the same map
  /// under a `"display-preview:"`-namespaced key.)
  var inFlight: [String: Task<Data?, Never>] = [:]
  var cameraPreviewWaiters: [String: Set<UUID>] = [:]

  /// Camera seeds must not wait behind multi-second authored RAW develops.
  /// Keep extraction bounded independently to avoid a cold-grid memory spike.
  let cameraPreviewGate = BoundedAsyncSemaphore(value: 2)

  public init() {}

  // MARK: - Concurrency gate

  /// Cancellation-aware permits with atomic handoff. Never reset the held
  /// count on folder switches: already-running decodes still owe a release.
  func acquireDecodeSlot() async throws {
    try await decodeSlots.acquire()
  }

  func releaseDecodeSlot() async {
    await decodeSlots.release()
  }

  // Multiple visible surfaces may share one producer. Cancellation owns a
  // consumer, not the producer, until the final consumer disappears.
  var thumbnailWaiters: [Task<Data?, Never>: Set<UUID>] = [:]
  var activeProducers: Set<UUID> = []
  var abandonedProducers: Set<UUID> = []
  var taskProducerIDs: [Task<Data?, Never>: UUID] = [:]
  /// Keyed by path plus original/sidecar signature, so every loader can
  /// share one extraction: a grid cell's seed is reused by the AVIF tiers.
  static let cameraPreviewCache: NSCache<NSString, NSData> = {
    let cache = NSCache<NSString, NSData>()
    cache.countLimit = 128
    return cache
  }()

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
  ///
  /// Nonisolated so a warm cache hit never queues behind other cells on this
  /// actor; only a miss enters it to coalesce and start a producer (#6010).
  public nonisolated func load(for assetURL: URL, scopeParentURL: URL?) async -> Data? {
    guard !Task.isCancelled else { return nil }
    // 1. Fast path: cached AVIF bytes.
    if let cached = await Self.decodableCachedThumbnail(for: assetURL) { return cached }
    guard !Task.isCancelled else { return nil }
    return await joinOrStartProducer(for: assetURL, scopeParentURL: scopeParentURL)
  }

  /// Cached bytes ImageIO can decode. Bytes read from disk are decoded once,
  /// off every actor, and the proof is kept with the memory entry, so repeat
  /// hits from the grid, the camera-seed probe and Preview cost no decode.
  /// An undecodable derivative is removed so the producer can rebuild it.
  nonisolated static func decodableCachedThumbnail(for assetURL: URL) async -> Data? {
    let cache = ThumbnailDiskCache.shared
    guard let hit = await cache.cachedThumbnail(for: assetURL) else { return nil }
    if hit.isKnownDecodable { return hit.data }
    if isUsableImageData(hit.data) {
      await cache.markDecodable(hit)
      return hit.data
    }
    thumbnailLoaderLogger.warning(
      "discarding unreadable cached thumbnail for \(assetURL.lastPathComponent, privacy: .public)"
    )
    await cache.removeThumbnail(for: assetURL)
    return nil
  }

  private func joinOrStartProducer(for assetURL: URL, scopeParentURL: URL?) async -> Data? {
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
    let coalescingKey = ThumbnailDiskCache.memoryKey(for: assetURL)
    if let existing = inFlight[coalescingKey], !existing.isCancelled {
      return await awaitThumbnail(existing)
    }

    // 3. Miss: invoke the Rust pipeline on a background-priority task.
    //    Scope claim MUST be on the bookmark-resolved ancestor — that's
    //    what `scopeParentURL` is for. The claim is held for the full
    //    span of the FFI call so the mmap inside `std::fs::read` sees
    //    an active scope.
    let scope = scopeParentURL ?? assetURL.deletingLastPathComponent()
    let task = startLocalProducer(key: coalescingKey) { [self] in
      await Self.produceThumbnail(loader: self, assetURL: assetURL, scope: scope)
    }
    return await awaitThumbnail(task)
  }

  /// Check that ImageIO can decode the cached image, not just read its header.
  /// Truncated AVIFs can expose valid dimensions while failing at pixel decode;
  /// accepting those bytes strands the grid and preview on placeholders. Decode
  /// only a tiny eager thumbnail here so the cache check stays inexpensive.
  nonisolated static func isUsableImageData(_ data: Data) -> Bool {
    guard
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      CGImageSourceGetCount(source) > 0,
      CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
        as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int
    else { return false }
    guard width > 0 && height > 0 else { return false }
    let decodeOptions: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: 32,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, decodeOptions as CFDictionary) != nil
  }

  /// Cancel every in-flight thumbnail load. Called by `AppShell` on folder
  /// switch so stale tasks don't keep computing against the old folder's
  /// files while the grid now shows different ones.
  public func cancelAll() {
    for task in inFlight.values { task.cancel() }
    inFlight.removeAll()
    cameraPreviewWaiters.removeAll()
    thumbnailWaiters.removeAll()
    activeProducers.removeAll()
    abandonedProducers.removeAll()
    taskProducerIDs.removeAll()
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

  /// Encode a CIImage to AVIF at the spec quality (`ThumbnailEncoder.quality`).
  /// (Internal, not private: shared by `ThumbnailLoader+DisplayPreview.swift`.)
  static func thumbnailData(from ci: CIImage, ctx: CIContext) -> Data? {
    return ThumbnailEncoder.encode(ci, ctx: ctx)
  }

  // MARK: - Helpers

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
  static func posterAVIF(at url: URL) async -> Data? {
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
    let scaled: CIImage =
      longEdge > target.width
      ? ci.transformed(
        by: CGAffineTransform(
          scaleX: target.width / longEdge,
          y: target.width / longEdge))
      : ci
    return thumbnailData(from: scaled, ctx: staticEncodeCIContext)
  }
}
