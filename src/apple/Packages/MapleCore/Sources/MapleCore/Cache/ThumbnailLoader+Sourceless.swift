// ThumbnailLoader+Sourceless.swift — the thumbnail path for assets with no
// filesystem URL (Maple Cloud, PhotoKit, SMB): the source's own thumbnail
// first, then a render from the original's bytes.

import CoreImage
import Foundation

extension ThumbnailLoader {
  /// Sourceless entry point — for assets without a filesystem URL (PhotoKit,
  /// SelfHosted). Order of attempts:
  ///   1. Disk cache hit on the asset's stable id. One whose server token is
  ///      out of date is returned at once and refetched in the background,
  ///      once per launch; different bytes that arrive are broadcast through
  ///      `ThumbnailRefresh`.
  ///   2. `source.thumb(for:)` — server-rendered or PhotoKit fast path.
  ///   3. Render-from-bytes fallback: `bytesProvider` → ImageIO for a
  ///      JPEG/HEIC/PNG, `PipelineRenderer.render(rawBytes:hint:)` for a RAW
  ///      → AVIF at 256 px long edge → cache.
  ///
  /// Returns `nil` when no path produced bytes (network down + no fallback,
  /// renderer failure, etc.).
  ///
  /// Nonisolated so a cache hit never queues behind the loader actor (#6017).
  public nonisolated func load(
    for asset: AssetRef,
    from source: (any ImageSource)?
  ) async -> Data? {
    // Determine cache key. Sourceless assets prefer their stable id;
    // filesystem-shaped assets fall through to the URL-keyed overload.
    if let url = asset.primaryURL {
      return await load(for: url, scopeParentURL: asset.scopeParentURL)
    }
    guard !Task.isCancelled else { return nil }
    let key = asset.stableID ?? asset.displayName

    // 1. Disk-cache hit; a token-stale one is shown while it is refetched.
    let token = Self.thumbToken(
      of: source, forStableID: asset.stableID, displayName: asset.displayName)
    if let hit = await ThumbnailDiskCache.shared.sourcelessThumbnail(
      forKey: key, currentToken: token)
    {
      if !hit.isCurrent, let source, let ref = Self.imageRef(of: asset) {
        await refreshStaleThumbnail(
          StaleRefetch(
            key: key, refreshKey: key.qualified(byHost: asset.cloudHostKey), ref: ref,
            source: source, token: token))
      }
      return hit.data
    }

    guard !Task.isCancelled else { return nil }
    return await joinSourcelessProducer(for: asset, key: key, from: source)
  }

  private func joinSourcelessProducer(
    for asset: AssetRef, key: String, from source: (any ImageSource)?
  ) async -> Data? {

    // 2. Coalesce duplicate requests, same no-await-between-check-and-
    //    insert contract as the URL-keyed overload above (this path
    //    previously had no coalescing at all: two cells requesting the
    //    same PhotoKit/SelfHosted asset each ran their own fetch +
    //    render). Namespaced so a stable id can never collide with the
    //    URL overload's `memoryKey(for:)` keys.
    let coalescingKey = "sourceless:" + key
    if let existing = inFlight[coalescingKey], !existing.isCancelled {
      return await awaitThumbnail(existing)
    }

    let provider = asset.bytesProvider
    let hint = asset.hintExtension ?? ""
    let ref = Self.imageRef(of: asset)
    // A producer, like the URL-keyed path: a Maple Cloud request already on
    // the wire finishes and fills the cache when its last cell scrolls away,
    // instead of being cancelled into the RAW-download fallback (#5735).
    let latencyBound = source?.thumbnailsAreLatencyBound ?? false
    let gate: ProducerGate = latencyBound ? .sourceFetch : .decode
    let task = startLocalProducer(key: coalescingKey, gate: gate) {
      await self.produceSourcelessThumbnail(
        source: source, ref: ref, key: key, coalescingKey: coalescingKey,
        provider: provider, hint: hint, producerHoldsDecodeSlot: !latencyBound)
    }
    return await awaitThumbnail(task)
  }

  private nonisolated static func thumbToken(
    of source: (any ImageSource)?, forStableID stableID: String?, displayName: String
  ) -> String? {
    guard let source, let stableID else { return nil }
    return source.thumbToken(
      for: ImageRef(id: stableID, displayName: displayName, smbPath: nil, smbSourceID: nil))
  }

  /// A failure to reach the source, or the source answering that it cannot
  /// serve the thumbnail yet, as opposed to answering that it has none.
  /// Re-downloading the whole original over the same unreachable or busy
  /// server cannot succeed where a few-KB thumbnail failed.
  nonisolated static func isTransientSourceFailure(_ error: any Error) -> Bool {
    error is URLError || error is CancellationError
      || error is AuthenticatedHTTPClient.AuthenticationError
      || CloudSource.isServerNotReady(error)
  }

  private nonisolated func produceSourcelessThumbnail(
    source: (any ImageSource)?, ref: ImageRef?, key: String, coalescingKey: String,
    provider: (@Sendable () async throws -> Data)?, hint: String, producerHoldsDecodeSlot: Bool
  ) async -> Data? {
    let token = ref.flatMap { source?.thumbToken(for: $0) }
    if let source, let ref {
      let fetched: Result<Data?, any Error> = await {
        do { return .success(try await source.thumb(for: ref)) } catch { return .failure(error) }
      }()
      switch fetched {
      case .success: await recordServerAnswer()
      case .failure(let error): await recordServerAnswer(failedWith: error)
      }
      if case .success(let bytes?) = fetched {
        guard !Task.isCancelled else { return nil }
        await ThumbnailDiskCache.shared.storeThumbnailData(bytes, forKey: key, token: token)
        return bytes
      }
      if case .failure(let error) = fetched, Self.isTransientSourceFailure(error) { return nil }
    }

    // Fallback: download the original and render it here. Only worth starting
    // while a cell still wants this thumbnail, and never for an original
    // that already failed to render.
    guard let provider, await fallbackIsWanted(key: key, coalescingKey: coalescingKey) else {
      return nil
    }
    if !producerHoldsDecodeSlot {
      guard await tradeFetchSlotForDecodeSlot(coalescingKey: coalescingKey) else { return nil }
    }
    let result = await renderFallback(
      provider: provider, hint: hint, key: key, source: source, ref: ref, token: token)
    if !producerHoldsDecodeSlot { await releaseDecodeSlot() }
    return result
  }

  // Built once per path: the SMB location pins the read and write-back to the
  // copy and share that listed it (#5051).
  private static func imageRef(of asset: AssetRef) -> ImageRef? {
    asset.stableID.map {
      ImageRef(
        id: $0, displayName: asset.displayName, smbPath: asset.smbPath,
        smbSourceID: asset.smbSourceID)
    }
  }

  private func refreshStaleThumbnail(_ refetch: StaleRefetch) {
    if let queued = pendingStaleRefetches.firstIndex(where: { $0.key == refetch.key }) {
      pendingStaleRefetches.append(pendingStaleRefetches.remove(at: queued))
      return
    }
    guard staleRefreshedKeys.insert(refetch.key).inserted else { return }
    pendingStaleRefetches.append(refetch)
    if pendingStaleRefetches.count > Self.maxPendingStaleRefetches {
      staleRefreshedKeys.remove(pendingStaleRefetches.removeFirst().key)
    }
    startPendingStaleRefetches()
  }

  /// A foreground producer in flight, or a server that is not ready, keeps queued refetches waiting.
  func startPendingStaleRefetches() {
    while !serverNotReady, taskProducerIDs.isEmpty,
      runningStaleRefetches < Self.maxConcurrentStaleRefetches,
      let next = pendingStaleRefetches.popLast()
    {
      runningStaleRefetches += 1
      Task.detached(priority: .utility) {
        await self.fetchStaleThumbnail(next)
        await self.finishStaleRefetch(next.key)
      }
    }
  }

  private func recordServerAnswer(failedWith error: (any Error)? = nil) {
    if let error {
      if CloudSource.isServerNotReady(error) { serverNotReady = true }
      return
    }
    serverNotReady = false
    startPendingStaleRefetches()
  }

  private func finishStaleRefetch(_ key: String) {
    runningStaleRefetches -= 1
    staleRefreshDidFinish?(key)
    startPendingStaleRefetches()
  }

  // No retry of its own: a failure leaves the stale copy, and the retry
  // scheduler only retries cells that got nothing.
  private nonisolated func fetchStaleThumbnail(_ refetch: StaleRefetch) async {
    let answer: Data?
    do {
      answer = try await refetch.source.thumb(for: refetch.ref)
    } catch {
      await recordServerAnswer(failedWith: error)
      return
    }
    await recordServerAnswer()
    guard let bytes = answer else { return }
    let cache = ThumbnailDiskCache.shared
    let cached = await cache.thumbnailData(forKey: refetch.key)
    await cache.storeThumbnailData(bytes, forKey: refetch.key, token: refetch.token)
    guard bytes != cached else { return }
    await ThumbnailRefresh.publish(assetKey: refetch.refreshKey, bytes: bytes)
  }

  private func fallbackIsWanted(key: String, coalescingKey: String) -> Bool {
    !unrenderableSourcelessKeys.contains(key) && waiterCount(forKey: coalescingKey) > 0
  }

  /// A fetch slot is for the cheap server request: a producer that moves on
  /// to the original's download hands it to the next queued tile, and waits
  /// for its decode slot inactive, so a cell that scrolls away cancels it.
  private func tradeFetchSlotForDecodeSlot(coalescingKey: String) async -> Bool {
    let producer = Self.producerID
    if let producer {
      setProducerActive(producer, false)
      await giveBackSlot(producer, gate: Self.producerGate)
    }
    do { try await acquireDecodeSlot() } catch { return false }
    guard !Task.isCancelled, waiterCount(forKey: coalescingKey) > 0 else {
      await releaseDecodeSlot()
      return false
    }
    if let producer { setProducerActive(producer, true) }
    return true
  }

  private nonisolated func renderFallback(
    provider: @Sendable () async throws -> Data, hint: String, key: String,
    source: (any ImageSource)?, ref: ImageRef?, token: String?
  ) async -> Data? {
    guard let bytes = try? await provider(), !Task.isCancelled else { return nil }
    guard let encoded = Self.fallbackThumbnails(from: bytes, hint: hint) else {
      await markUnrenderable(key)
      return nil
    }
    await Self.persistFallbackRender(
      localData: encoded.local, onShareData: encoded.onShare,
      key: key, source: source, ref: ref, token: token)
    return encoded.local
  }

  private func markUnrenderable(_ key: String) {
    unrenderableSourcelessKeys.insert(key)
  }

  /// The local-grid thumbnail and the on-share write-back candidate (#2690),
  /// both encoded from one decode. The candidate uses the canonical shared
  /// contract (512 px / q0.55, the API's `THUMB_LONG_EDGE_PX` /
  /// `THUMB_AVIF_QUALITY`), never the smaller local-grid size: the API never
  /// re-renders over a fresher shared file, so a small one would stick for
  /// every other client.
  nonisolated static func fallbackThumbnails(
    from bytes: Data, hint: String
  ) -> (local: Data, onShare: Data?)? {
    if NonRawImageExtensions.all.contains(hint.lowercased()) {
      guard let image = orientedNonRawImage(from: bytes),
        let local = downscaledNonRawAVIF(image)
      else { return nil }
      return (
        local,
        downscaledNonRawAVIF(
          image, targetLongEdge: MapleThumbCacheKey.onShareThumbLongEdgePx,
          quality: MapleThumbCacheKey.onShareThumbAVIFQuality)
      )
    }
    guard let image = try? PipelineRenderer.render(rawBytes: bytes, hint: hint, quality: .preview),
      let local = encodeThumbnail(image, ctx: staticEncodeCIContext)
    else { return nil }
    return (
      local,
      encodeThumbnail(
        image, ctx: staticEncodeCIContext,
        targetLongEdge: MapleThumbCacheKey.onShareThumbLongEdgePx,
        quality: MapleThumbCacheKey.onShareThumbAVIFQuality)
    )
  }

  /// Persists a render-from-bytes fallback's output: stores `localData`
  /// (the local-grid-sized AVIF) in `ThumbnailDiskCache`, and — when the
  /// source has somewhere shared to put it — fires the on-share
  /// write-back as an UNSTRUCTURED, un-awaited `Task` rather than
  /// `await`ing `source.writeThumb` inline.
  ///
  /// This is deliberate (#2690 review): `writeThumb` for `SMBSource` is
  /// up to four network round trips (create-directory, temp write,
  /// best-effort remove, rename) over SMB. Awaiting it here would hold
  /// BOTH the caller of `load(for:from:)` (a grid cell, on a cold
  /// 200-asset browse that's every cell in the grid) and the decode-slot
  /// gate (released by the caller right after this function returns)
  /// through that network round-trip chain — serializing the whole grid
  /// behind SMB writes on a slow share, which is worse than not having
  /// an on-share cache at all. Firing detached lets this function — and
  /// therefore `load(for:from:)` — return as soon as the LOCAL cache
  /// write lands, exactly like the disk-cache-only behavior before
  /// `writeThumb` existed; the write-back completes independently and
  /// its result is never observed by the caller (by design — see
  /// `ImageSource.writeThumb`'s doc comment on why it can't throw).
  ///
  /// Split out from the render closure specifically so this dispatch
  /// behavior is unit-testable without a real RAW decode (no FFI-mocking
  /// seam exists for `PipelineRenderer` — see `ThumbnailLoaderTests.swift`'s
  /// header) — `ThumbnailLoaderWriteBackTests` drives THIS function
  /// directly with a gated stub source to pin "returns before the
  /// write-back completes" and "write-back receives the right bytes/ref."
  static func persistFallbackRender(
    localData: Data, onShareData: Data?, key: String,
    source: (any ImageSource)?, ref: ImageRef?, token: String? = nil
  ) async {
    await ThumbnailDiskCache.shared.storeThumbnailData(localData, forKey: key, token: token)
    guard let source, let ref, let onShareData else { return }
    Task.detached(priority: .background) {
      await source.writeThumb(onShareData, for: ref)
    }
  }
}
