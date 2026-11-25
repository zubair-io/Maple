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
    guard !Task.isCancelled else { return nil }
    let key = asset.stableID ?? asset.displayName

    // 1. Disk-cache hit.
    if let cached = await ThumbnailDiskCache.shared.thumbnailData(forKey: key) {
      return cached
    }

    guard !Task.isCancelled else { return nil }

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

  /// A failure to reach the source, as opposed to the source answering that
  /// it has no thumbnail. Re-downloading the whole original over the same
  /// unreachable or slow link cannot succeed where a few-KB thumbnail failed.
  nonisolated static func isTransientSourceFailure(_ error: any Error) -> Bool {
    error is URLError || error is CancellationError
      || error is AuthenticatedHTTPClient.AuthenticationError
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

    // Fallback: pull RAW bytes through the asset's provider, render via the
    // Rust pipeline, encode AVIF, persist. A full RAW download is only worth
    // starting while a cell still wants this thumbnail; one that scrolled
    // away must not hold a decode slot and the network for nobody.
    guard let provider, await waiterCount(forKey: coalescingKey) > 0 else { return nil }
    if !producerHoldsDecodeSlot {
      do { try await acquireDecodeSlot() } catch { return nil }
      guard await waiterCount(forKey: coalescingKey) > 0 else {
        await releaseDecodeSlot()
        return nil
      }
    }
    let result: Data? = await {
      do {
        let bytes = try await provider()
        try Task.checkCancellation()
        let image = try PipelineRenderer.render(
          rawBytes: bytes, hint: hint, quality: .preview)
        guard let data = Self.encodeThumbnail(image, ctx: Self.staticEncodeCIContext) else {
          return nil
        }
        // On-share write-back candidate (#2690), re-encoded from
        // the SAME already-decoded `image` at the CANONICAL
        // contract size/quality — 512px/q0.55, matching the
        // API's `THUMB_LONG_EDGE_PX`/`THUMB_AVIF_QUALITY`
        // (`MapleThumbCacheKey`'s doc comment) — NOT `data`
        // above, which is the smaller 256px/q0.5 local-grid
        // render. Persisting the local-grid size to the shared
        // path would permanently downgrade that entry for every
        // other client, since the API's mtime-freshness guard
        // never re-renders over a fresher file once one exists.
        let onShareData = Self.encodeThumbnail(
          image, ctx: Self.staticEncodeCIContext,
          targetLongEdge: MapleThumbCacheKey.onShareThumbLongEdgePx,
          quality: MapleThumbCacheKey.onShareThumbAVIFQuality)
        await Self.persistFallbackRender(
          localData: data, onShareData: onShareData,
          key: key, source: source, ref: ref)
        return data
      } catch {
        return nil
      }
    }()
    if !producerHoldsDecodeSlot { await releaseDecodeSlot() }
    return result
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
