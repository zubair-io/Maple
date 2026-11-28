// ThumbnailLoader+Sourceless.swift — the thumbnail path for assets with no
// filesystem URL (Maple Cloud, PhotoKit, SMB): the source's own thumbnail
// first, then a render from the original's bytes.

import CoreImage
import Foundation

extension ThumbnailLoader {
  /// Sourceless entry point — for assets without a filesystem URL (PhotoKit,
  /// SelfHosted). Order of attempts:
  ///   1. Disk cache hit on the asset's stable id.
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

    // 1. Disk-cache hit.
    if let cached = await ThumbnailDiskCache.shared.thumbnailData(forKey: key) {
      return cached
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

    let stableID = asset.stableID
    let displayName = asset.displayName
    let provider = asset.bytesProvider
    let hint = asset.hintExtension ?? ""
    // Built once, reused by both the source.thumb() branch and the
    // fallback's write-back call below. The SMB location pins the read and
    // write-back to the copy and share that listed it (#5051).
    let smbPath = asset.smbPath
    let smbSourceID = asset.smbSourceID
    let ref = stableID.map {
      ImageRef(id: $0, displayName: displayName, smbPath: smbPath, smbSourceID: smbSourceID)
    }
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
    if let source, let ref {
      do {
        if let bytes = try await source.thumb(for: ref) {
          guard !Task.isCancelled else { return nil }
          await ThumbnailDiskCache.shared.storeThumbnailData(bytes, forKey: key)
          return bytes
        }
      } catch {
        if Self.isTransientSourceFailure(error) { return nil }
      }
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
      provider: provider, hint: hint, key: key, source: source, ref: ref)
    if !producerHoldsDecodeSlot { await releaseDecodeSlot() }
    return result
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
    source: (any ImageSource)?, ref: ImageRef?
  ) async -> Data? {
    guard let bytes = try? await provider(), !Task.isCancelled else { return nil }
    guard let encoded = Self.fallbackThumbnails(from: bytes, hint: hint) else {
      await markUnrenderable(key)
      return nil
    }
    await Self.persistFallbackRender(
      localData: encoded.local, onShareData: encoded.onShare,
      key: key, source: source, ref: ref)
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
    source: (any ImageSource)?, ref: ImageRef?
  ) async {
    await ThumbnailDiskCache.shared.storeThumbnailData(localData, forKey: key)
    guard let source, let ref, let onShareData else { return }
    Task.detached(priority: .background) {
      await source.writeThumb(onShareData, for: ref)
    }
  }
}
