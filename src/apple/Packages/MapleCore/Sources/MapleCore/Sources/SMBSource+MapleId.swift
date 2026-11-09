import AMSMB2
import Foundation

extension SMBSource {
  // MARK: - maple_id derivation (#1995)

  /// Resolve a maple_id for `asset`, consulting the share's id-cache first
  /// (`MapleIdCacheStore.lookup`) and only re-deriving (then persisting) on
  /// a cache miss or a stale entry (size/mtime mismatch — the file was
  /// replaced at this path since the id was last computed). Returns `nil`
  /// when not connected or derivation itself fails; `images()` falls back
  /// to the share-relative path in that case.
  ///
  /// Staleness scope: `asset.size`/`asset.mtime` come from the listing
  /// snapshot taken at `connect()` (`listRAWFiles`), not a fresh
  /// `attributesOfItem` stat per call — an intentional trade-off, unlike
  /// `FilesystemSource.mapleId(for:)`, which DOES re-stat on every call
  /// (cheap: a local syscall). Re-statting every asset over SMB on every
  /// `images()` call would reintroduce a per-file network round-trip on
  /// every UI refresh — exactly the cost this cache exists to avoid. A
  /// file replaced at the same path is still correctly detected across
  /// browses (each `connect()` re-lists and captures fresh size/mtime),
  /// just not for a replacement that happens to land between two
  /// `images()` calls on the SAME still-open connection without an
  /// intervening reconnect.
  func mapleId(
    for asset: SMBAsset, client: SMB2Manager?, idCache: MapleIdCacheStore?
  ) async -> String? {
    guard let client, let idCache else { return nil }
    if let cached = await idCache.lookup(
      path: asset.path, size: asset.size, mtime: asset.mtime.timeIntervalSince1970)
    {
      return cached
    }
    guard let derived = await deriveMapleId(for: asset, client: client) else { return nil }
    await idCache.record(
      path: asset.path, mapleId: derived,
      size: asset.size, mtime: asset.mtime.timeIntervalSince1970)
    return derived
  }

  /// Derive a maple_id from scratch over SMB: a single bounded range read
  /// (`0..<64KB`) supplies the primary-form head hash input, and the capture
  /// date is read by ranged reads of its own (`MapleIdDerivation.capturedAt`:
  /// the EXIF tag bytes of a still wherever its IFDs sit, the `moov` atom of
  /// a video), so a file whose metadata lies past the head is dated exactly
  /// as the server dates it. Only when primary form isn't viable does
  /// this stream the WHOLE file — via AMSMB2's native
  /// `AsyncThrowingStream` range-read API, never materialised as one
  /// buffer — through `FallbackFormHasher`.
  private func deriveMapleId(for asset: SMBAsset, client: SMB2Manager) async -> String? {
    guard
      let headBytes = try? await client.contents(
        atPath: asset.path, range: UInt64(0)..<UInt64(Self.mapleIdHeadByteCount))
    else { return nil }
    guard !headBytes.isEmpty else { return nil }

    let reader = ByteRangeReader(size: UInt64(asset.size)) { offset, length in
      try await client.contents(atPath: asset.path, range: offset..<offset + UInt64(length))
    }
    let capturedAt: String?
    do {
      capturedAt = try await MapleIdDerivation.capturedAt(
        fileExtension: (asset.path as NSString).pathExtension, reader: reader)
    } catch {
      return nil
    }

    // ONE stream, ONE iterator, shared by reference across every
    // `nextChunk()` call — `client.contents(atPath:)` opens a fresh
    // `SMB2FileHandle` and starts reading from byte 0 each time it's
    // called, so calling it again per chunk would silently re-read the
    // same leading bytes forever instead of advancing through the file.
    var iterator: AsyncThrowingStream<Data, any Error>.Iterator?

    // `try?`: a mid-stream SMB read failure (dropped connection, etc.)
    // must not surface a partial/wrong id — `derive` is `rethrows`
    // because `nextChunk` can throw, so a thrown error here correctly
    // collapses to `nil`, matching this function's established
    // fail-safe-to-nil contract (see the `headBytes` guard above).
    return try? await MapleIdDerivation.derive(
      headBytes: headBytes,
      capturedAtISO8601: capturedAt,
      filesize: UInt64(asset.size),
      nextChunk: {
        // Primary-form identity never requests a whole-file stream.
        if iterator == nil { iterator = client.contents(atPath: asset.path).makeAsyncIterator() }
        return (try await iterator?.next()) ?? Data()
      }
    )
  }
}
