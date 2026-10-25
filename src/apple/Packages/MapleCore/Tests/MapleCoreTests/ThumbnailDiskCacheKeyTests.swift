// ThumbnailDiskCacheKeyTests.swift — pins `ThumbnailDiskCache.cacheKey(for:)`,
// which names the frozen legacy `<key>.v25.avif` thumb, to the same
// `sha256(basename)[:16]` derivation used by:
//   - Web (Maple Hosted Angular): src/web/projects/maple-common/src/lib/maple-cache/sha.ts
//   - Server (Bun indexer):       src/api/src/fs/xmp.ts (sha256Prefix16)
//
// If it drifts, legacy thumbs another layer wrote are no longer adopted —
// see issue #108. Current thumbs use the unhashed `<filename.ext>.avif`.
//
// #2254: the vectors above only pinned the HASH FUNCTION, never whether the
// code that actually *writes* a thumb agrees with the code that *reads* one
// back. That gap let the server's `thumb` stage drift onto a `<maple_id>.avif`
// destination for months while this suite stayed green (#1999 / PR #2252).
// The "Writer-vs-reader path parity" section below closes the Apple side of
// that hole: it writes through the real `ThumbnailDiskCache` and asserts the
// file lands at the pinned `<asset folder>/.maple/thumbs/<filename.ext>.avif`
// that `ThumbnailLoader.produceThumbnail` and the server read (#1365),
// directory included — not just that both hash to the same stem.

import XCTest

@testable import MapleCore

final class ThumbnailDiskCacheKeyTests: XCTestCase {

  private var tmp: URL!

  override func setUp() async throws {
    tmp = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("maple-thumbcache-key-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: tmp, withIntermediateDirectories: true
    )
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: tmp)
  }

  // MARK: - Cross-platform parity

  /// Pinned vectors generated server-side via
  ///   `node -e "console.log(require('crypto').createHash('sha256').update(NAME,'utf8').digest('hex').slice(0,16))"`
  /// or
  ///   `python3 -c "import hashlib; print(hashlib.sha256(b'NAME').hexdigest()[:16])"`
  ///
  /// These are the EXACT 16 hex chars the Bun indexer (`sha256Prefix16`)
  /// and the web maple-cache (`bytesToHex(sha256(...)).slice(0,16)`)
  /// would emit. Any divergence breaks `.maple/thumbs/` interop.
  func testCacheKeyMatchesCrossPlatformVectors() {
    let cases: [(filename: String, expected: String)] = [
      ("IMG_0001.ARW", "8fd710b39cdc1a26"),
      ("test.dng", "b9011a0233accea2"),
      ("IMG_1234.dng", "7ad25b268a071d01"),
      ("photo.HEIC", "db03400ba7adff45"),
    ]
    for (filename, expected) in cases {
      // Single-source-of-truth helper (same one ThumbnailDiskCache uses).
      XCTAssertEqual(
        MapleThumbCacheKey.sha256Prefix16(filename),
        expected,
        "sha256Prefix16(\(filename)) drift — see src/web/.../sha.ts"
      )
      // And the cache wraps it for any URL whose lastPathComponent matches.
      let url = URL(fileURLWithPath: "/folder/sub/\(filename)")
      XCTAssertEqual(
        ThumbnailDiskCache.cacheKey(for: url),
        expected,
        "ThumbnailDiskCache.cacheKey diverged from sha256Prefix16(basename)"
      )
    }
  }

  func testCacheKeyIs16HexChars() {
    let url = URL(fileURLWithPath: "/tmp/library/IMG_1234.dng")
    let key = ThumbnailDiskCache.cacheKey(for: url)
    XCTAssertEqual(key.count, 16)
    XCTAssertTrue(
      key.allSatisfy { $0.isHexDigit && (!$0.isLetter || $0.isLowercase) },
      "expected lowercase hex; got \(key)"
    )
  }

  // MARK: - Legacy name is basename-derived
  //
  // The frozen legacy thumb name depends only on the filename (so `.maple/`
  // travels with the photos, issue #108); memory keys are full-path (#5033).

  func testLegacyThumbNameIsTheSameForSameBasenameInAnyFolder() {
    let a = URL(fileURLWithPath: "/folder/A/IMG.dng")
    let b = URL(fileURLWithPath: "/folder/B/IMG.dng")
    XCTAssertEqual(ThumbnailDiskCache.cacheKey(for: a), ThumbnailDiskCache.cacheKey(for: b))
    XCTAssertNotEqual(ThumbnailDiskCache.memoryKey(for: a), ThumbnailDiskCache.memoryKey(for: b))
  }

  func testDifferentBasenamesProduceDifferentKeys() {
    let a = URL(fileURLWithPath: "/lib/IMG_0001.dng")
    let b = URL(fileURLWithPath: "/lib/IMG_0002.dng")
    XCTAssertNotEqual(
      ThumbnailDiskCache.cacheKey(for: a),
      ThumbnailDiskCache.cacheKey(for: b)
    )
  }

  // MARK: - Round-trip lands at the expected on-disk path

  func testStoreWritesFileAtTheUnhashedFilenamePath() async {
    let cache = ThumbnailDiskCache()
    await cache.configure(folderURL: tmp)

    let asset = tmp.appendingPathComponent("IMG_1234.dng")
    let payload = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46])

    await cache.storeThumbnailData(payload, for: asset)

    let expectedFile =
      tmp
      .appendingPathComponent(".maple/thumbs")
      .appendingPathComponent("IMG_1234.dng.avif")

    XCTAssertTrue(
      FileManager.default.fileExists(atPath: expectedFile.path),
      "expected thumb at \(expectedFile.path); on-disk name drifted from <filename>.avif"
    )

    let onDisk = try? Data(contentsOf: expectedFile)
    XCTAssertEqual(onDisk, payload)
  }

  func testSidecarRenderCannotBeStampedAgainstNewerXMP() async throws {
    let cache = ThumbnailDiskCache()
    await cache.configure(folderURL: tmp)
    let asset = tmp.appendingPathComponent("snapshot.png")
    let sidecar = SidecarPath.sidecarURL(for: asset)
    try Data([1, 2, 3]).write(to: asset)
    try Data("old".utf8).write(to: sidecar)
    let renderedFrom = LocalDerivativeSourceStamp.signature(for: asset)
    try FileManager.default.removeItem(at: sidecar)
    try Data("newer sidecar".utf8).write(to: sidecar)

    let accepted = await cache.storeThumbnailDataIfCurrent(
      Data([4, 5, 6]), for: asset, sourceSignature: renderedFrom)
    XCTAssertFalse(accepted)
    let cached = await cache.thumbnailData(for: asset)
    XCTAssertNil(cached)
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: MapleSidecarPaths.thumbURL(for: asset).path))
  }

  func testUnstampedLegacyThumbIsNotServed() async throws {
    let cache = ThumbnailDiskCache()
    await cache.configure(folderURL: tmp)
    let asset = tmp.appendingPathComponent("IMG_1234.dng")
    let thumbs = tmp.appendingPathComponent(".maple/thumbs")
    let hash = MapleThumbCacheKey.sha256Prefix16("IMG_1234.dng")
    let legacy = thumbs.appendingPathComponent("\(hash).v25.avif")
    let payload = Data([0x0A, 0x0B, 0x0C])
    try payload.write(to: legacy)

    let fetched = await cache.thumbnailData(for: asset)

    XCTAssertNil(fetched, "legacy bytes cannot prove which sidecar produced them")
    XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: thumbs.appendingPathComponent("IMG_1234.dng.avif").path))
  }

  func testExternalSidecarRemovalInvalidatesWarmAndColdThumbnails() async throws {
    let asset = tmp.appendingPathComponent("photo.jpg")
    try Data([0x01]).write(to: asset)
    let sidecar = SidecarPath.sidecarURL(for: asset)
    try Data("<xmp>A</xmp>".utf8).write(to: sidecar)
    let cache = ThumbnailDiskCache()
    let first = Data([0x0A])
    await cache.storeThumbnailData(first, for: asset)
    let warmBeforeRemoval = await cache.thumbnailData(for: asset)
    XCTAssertEqual(warmBeforeRemoval, first)

    try FileManager.default.removeItem(at: sidecar)
    let warmAfterRemoval = await cache.thumbnailData(for: asset)
    XCTAssertNil(warmAfterRemoval, "warm bytes must expire after removal")
    let coldCache = ThumbnailDiskCache()
    let coldAfterRemoval = await coldCache.thumbnailData(for: asset)
    XCTAssertNil(coldAfterRemoval, "disk bytes must expire after relaunch")

    let regenerated = Data([0x0B])
    await coldCache.storeThumbnailData(regenerated, for: asset)
    let fresh = await coldCache.thumbnailData(for: asset)
    XCTAssertEqual(fresh, regenerated)
  }

  // MARK: - Files outside the open folder (#5033)
  //
  // The unified Timeline shows files from every saved folder at once, so two
  // folders' `IMG_0001.dng` must not share one thumbnail, and neither may land
  // in the open folder's `.maple/thumbs/`.

  func testSameNamedFilesOutsideTheOpenFolderKeepTheirOwnThumbnails() async throws {
    let open = tmp.appendingPathComponent("open")
    let folderA = tmp.appendingPathComponent("a")
    let folderB = tmp.appendingPathComponent("b")
    for dir in [open, folderA, folderB] {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    let cache = ThumbnailDiskCache()
    await cache.configure(folderURL: open)
    let assetA = folderA.appendingPathComponent("IMG_0001.dng")
    let assetB = folderB.appendingPathComponent("IMG_0001.dng")
    let payloadA = Data([0xA1, 0xA2])
    let payloadB = Data([0xB1, 0xB2])

    await cache.storeThumbnailData(payloadA, for: assetA)
    await cache.storeThumbnailData(payloadB, for: assetB)

    let readA = await cache.thumbnailData(for: assetA)
    let readB = await cache.thumbnailData(for: assetB)
    let readOpen = await cache.thumbnailData(for: open.appendingPathComponent("IMG_0001.dng"))
    XCTAssertEqual(readA, payloadA)
    XCTAssertEqual(readB, payloadB)
    XCTAssertNil(readOpen, "another folder's thumbnail must not answer for the open folder's file")
    XCTAssertEqual(try Data(contentsOf: MapleSidecarPaths.thumbURL(for: assetA)), payloadA)
    XCTAssertEqual(try Data(contentsOf: MapleSidecarPaths.thumbURL(for: assetB)), payloadB)
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: open.appendingPathComponent(".maple/thumbs/IMG_0001.dng.avif").path))
  }

  func testSameNamedFilesInSubfoldersOfTheOpenFolderKeepTheirOwnThumbnails() async throws {
    let parent = tmp.appendingPathComponent("Pictures")
    let year2024 = parent.appendingPathComponent("2024")
    let year2025 = parent.appendingPathComponent("2025")
    for dir in [year2024, year2025] {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    let cache = ThumbnailDiskCache()
    await cache.configure(folderURL: parent)
    let asset2024 = year2024.appendingPathComponent("IMG_0001.dng")
    let asset2025 = year2025.appendingPathComponent("IMG_0001.dng")

    await cache.storeThumbnailData(Data([0x24]), for: asset2024)
    await cache.storeThumbnailData(Data([0x25]), for: asset2025)

    let read2024 = await cache.thumbnailData(for: asset2024)
    let read2025 = await cache.thumbnailData(for: asset2025)
    XCTAssertEqual(read2024, Data([0x24]))
    XCTAssertEqual(read2025, Data([0x25]))
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: parent.appendingPathComponent(".maple/thumbs/IMG_0001.dng.avif").path))
  }

  /// A file's thumbnail updated while another folder was open must not be
  /// shadowed by its pre-edit copy once its own folder is open again.
  func testAThumbnailUpdatedWhileAnotherFolderWasOpenIsCurrentAfterReturning() async throws {
    let home = tmp.appendingPathComponent("home")
    let away = tmp.appendingPathComponent("away")
    for dir in [home, away] {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    let cache = ThumbnailDiskCache()
    let asset = home.appendingPathComponent("X.dng")
    await cache.configure(folderURL: home)
    await cache.storeThumbnailData(Data([0x01]), for: asset)

    await cache.configure(folderURL: away)
    await cache.storeThumbnailData(Data([0x02]), for: asset)
    await cache.configure(folderURL: home)

    let read = await cache.thumbnailData(for: asset)
    XCTAssertEqual(read, Data([0x02]))
    XCTAssertEqual(cache.syncPeekData(for: asset), Data([0x02]))
  }

  func testSyncPeekForAFileOutsideTheOpenFolderSeesOnlyItsOwnThumbnail() async throws {
    let open = tmp.appendingPathComponent("open")
    let other = tmp.appendingPathComponent("other")
    for dir in [open, other] {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    let cache = ThumbnailDiskCache()
    await cache.configure(folderURL: open)
    let inOpen = open.appendingPathComponent("IMG_0001.dng")
    let outside = other.appendingPathComponent("IMG_0001.dng")

    await cache.storeThumbnailData(Data([0x01]), for: inOpen)

    XCTAssertEqual(cache.syncPeekData(for: inOpen), Data([0x01]))
    XCTAssertNil(cache.syncPeekData(for: outside))
  }

  // MARK: - Writer-vs-reader path parity (#2254)
  //
  // The writer for locally-generated thumbs must land at the pinned path the
  // API's `thumb` stage and Web use, so a thumb any layer drops is picked up
  // without a local re-decode. Asserting only the hash STEM would have missed
  // the #1999 regression, where the divergence was in the DIRECTORY. This is
  // the Apple sibling of the API's `xmp.test.ts` "agrees with
  // resolveThumbPath for the same file" (PR #2252).
  func testStoreWritesToTheExactPathMapleSidecarPathsResolvesForReading() async throws {
    let assetDir = tmp.appendingPathComponent("library")
    // Throwing `try`, not `try?`: if the fixture directory can't be created,
    // this must fail HERE. Swallowing it would surface later as a cache-write
    // or path-mismatch failure and read as a parity regression that isn't one
    // — the wrong-root-cause trap this whole suite exists to avoid.
    try FileManager.default.createDirectory(at: assetDir, withIntermediateDirectories: true)
    let assetURL = assetDir.appendingPathComponent("IMG_1234.dng")

    // Writer: ThumbnailDiskCache configured for the asset's OWN directory
    // (mirrors how the app configures the singleton for the open folder).
    let cache = ThumbnailDiskCache()
    await cache.configure(folderURL: assetDir)
    let payload = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46])
    await cache.storeThumbnailData(payload, for: assetURL)

    // Reader: the independently-implemented resolver.
    let readerPath = MapleSidecarPaths.thumbURL(for: assetURL)

    let expectedPath =
      assetDir
      .appendingPathComponent(".maple")
      .appendingPathComponent("thumbs")
      .appendingPathComponent("IMG_1234.dng.avif")

    XCTAssertEqual(
      readerPath.path, expectedPath.path,
      "MapleSidecarPaths.thumbURL drifted from the pinned <folder>/.maple/thumbs/<stem>.avif convention"
    )
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: readerPath.path),
      "ThumbnailDiskCache wrote somewhere MapleSidecarPaths.thumbURL does not look — "
        + "this is the exact #1999 failure mode (writer/reader path divergence)"
    )
    XCTAssertEqual(
      try? Data(contentsOf: readerPath), payload,
      "file exists at the reader's path but its contents don't match what the writer stored"
    )
  }
}
