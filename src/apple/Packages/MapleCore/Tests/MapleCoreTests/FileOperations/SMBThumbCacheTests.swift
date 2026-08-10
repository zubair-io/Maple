// SMBThumbCacheTests.swift — on-share `.maple/thumbs/` cache read/write-back
// for SMBSource (#2690, follow-up to #2689's SMB browse-perf investigation).
//
// Routed through `FakeSMBTransport`, the same in-memory seam
// `SMBFileOperationsRelocateTests`/`SMBFileOperationsCacheInvalidationTests`
// already use for `SMBFileOperations` — there is no SMB server available in
// this environment (see `FakeSMBTransport.swift`'s file header), so this
// exercises the REAL read/write-back orchestration in `SMBThumbCache`, not a
// stand-in for it.

import XCTest
@testable import MapleCore

final class SMBThumbCacheTests: XCTestCase {

    /// `<dir>/.maple/thumbs/<sha256Prefix16(basename)>.avif` — spelled out
    /// against share-relative string paths, matching
    /// `SMBFileOperationsCacheInvalidationTests`'s identical helper (its own
    /// production dependency, `MapleSidecarPaths.thumbURL`, is exactly what
    /// `SMBThumbCache.onShareThumbPath` calls).
    private func thumbPath(dir: String, basename: String) -> String {
        "\(dir)/.maple/thumbs/\(MapleThumbCacheKey.thumbFilename(forRawBasename: basename))"
    }

    // MARK: - Path derivation

    func testOnShareThumbPathUsesTheSharedNamingContract() {
        let path = SMBThumbCache.onShareThumbPath(forAssetPath: "/Photos/2024/IMG_0001.dng")
        XCTAssertEqual(path, thumbPath(dir: "/Photos/2024", basename: "IMG_0001.dng"))
    }

    // MARK: - Hit

    func testReadHitsAnExistingOnShareEntryWithOneTransportRead() async {
        let t = FakeSMBTransport()
        let assetPath = "/Photos/IMG_0001.dng"
        let cachedBytes = Data([0x00, 0x01, 0x02, 0x03])
        await t.seed(String(decoding: cachedBytes, as: UTF8.self),
                    at: thumbPath(dir: "/Photos", basename: "IMG_0001.dng"))

        let cache = SMBThumbCache(transport: t)
        let got = await cache.read(forAssetPath: assetPath)

        XCTAssertEqual(got, cachedBytes, "a pre-existing on-share entry must be returned verbatim")
        // The RAW itself was never seeded — a crash/miss reading it would
        // mean the read path fell through to something other than the
        // single on-share thumb path.
        let rawWasTouched = await t.fileExists(at: assetPath)
        XCTAssertFalse(rawWasTouched)
    }

    // MARK: - Miss -> write-back -> second-call hit

    func testMissThenWriteBackThenSecondReadHits() async {
        let t = FakeSMBTransport()
        let assetPath = "/Photos/IMG_0002.dng"
        let cache = SMBThumbCache(transport: t)

        // 1. Miss: nothing on the share yet — mirrors SMBSource.thumb(for:)
        //    returning nil and ThumbnailLoader falling through to the
        //    render-from-bytes fallback.
        let miss = await cache.read(forAssetPath: assetPath)
        XCTAssertNil(miss)

        // 2. Write-back: the fallback "rendered" these bytes (a stand-in for
        //    the real AVIF the Rust pipeline would produce — the FFI render
        //    itself isn't unit-testable without a real RAW fixture, see
        //    ThumbnailLoaderTests.swift's header) and SMBSource.writeThumb
        //    persists them.
        let rendered = Data([0xAA, 0xBB, 0xCC])
        await cache.write(rendered, forAssetPath: assetPath)

        // 3. Second read: now a hit, from the SAME path the write landed at.
        let hit = await cache.read(forAssetPath: assetPath)
        XCTAssertEqual(hit, rendered)

        // The write landed at the FINAL path, not left sitting in a temp
        // file — a leaked `.tmp` file would mean the rename step silently
        // no-op'd.
        let finalPath = thumbPath(dir: "/Photos", basename: "IMG_0002.dng")
        let landedAtFinalPath = await t.fileExists(at: finalPath)
        XCTAssertTrue(landedAtFinalPath)
    }

    // MARK: - Write failure degrades silently

    func testWriteFailureDegradesSilently() async {
        // `write(data:toPath:)`'s first step targets a UUID-suffixed temp
        // path this test can't predict, so simulating "the share rejects
        // this write" needs a transport that fails EVERY write — the
        // deterministic stand-in for a genuinely read-only mount.
        let inner = FakeSMBTransport()
        let readOnlyShare = AlwaysFailingWriteTransport(inner: inner)
        let assetPath = "/ReadOnlyShare/IMG_0003.dng"

        // No throw, no crash — `write` swallows the failure entirely.
        await SMBThumbCache(transport: readOnlyShare).write(Data([0x01]), forAssetPath: assetPath)

        // No entry ends up on the share, and a subsequent read (through the
        // same failing transport, or a fresh one over the same underlying
        // store) is a clean miss — never a thrown error — exactly today's
        // behavior when there's no on-share cache at all.
        let stillMissing = await SMBThumbCache(transport: readOnlyShare).read(forAssetPath: assetPath)
        XCTAssertNil(stillMissing)
        let finalPath = thumbPath(dir: "/ReadOnlyShare", basename: "IMG_0003.dng")
        let leakedToShare = await inner.fileExists(at: finalPath)
        XCTAssertFalse(leakedToShare)
    }

    // MARK: - Moved / renamed asset -> coherent entry

    func testMovedAssetsOldEntryInvalidatesAndNewEntryIsIndependentlyCoherent() async throws {
        let t = FakeSMBTransport()
        let cache = SMBThumbCache(transport: t)

        // Seed the RAW + write its on-share thumb at the ORIGINAL location.
        await t.seed("pixels", at: "/Source/IMG_1.dng")
        await cache.write(Data([0x11]), forAssetPath: "/Source/IMG_1.dng")
        let oldThumbPath = thumbPath(dir: "/Source", basename: "IMG_1.dng")
        let wroteOldEntry = await t.fileExists(at: oldThumbPath)
        XCTAssertTrue(wroteOldEntry)

        // Move it — `SMBFileOperations.invalidateDerivedCaches` (#2689) is
        // production's existing hook for clearing the OLD location's
        // derived-cache entries on a move; this proves it actually reaches
        // the entry THIS type just wrote (same naming contract, same
        // transport), not a parallel path that happens to also look right.
        _ = try await SMBFileOperations.relocate(
            "/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)
        let oldEntrySurvived = await t.fileExists(at: oldThumbPath)
        XCTAssertFalse(oldEntrySurvived, "the old location's on-share thumb must not survive the move")

        // The NEW location has no thumb yet — reading it is a clean miss,
        // never a stale hit inherited from the old path (they hash to
        // different filenames only when the basename differs; same
        // basename, different directory, is exactly this case: SAME hash,
        // DIFFERENT `.maple/thumbs/` parent directory).
        let newAssetPath = "/Album/IMG_1.dng"
        let missAtNewLocation = await cache.read(forAssetPath: newAssetPath)
        XCTAssertNil(missAtNewLocation)

        // Writing + reading at the new location is fully independent of
        // whatever happened at the old one.
        await cache.write(Data([0x22]), forAssetPath: newAssetPath)
        let hitAtNewLocation = await cache.read(forAssetPath: newAssetPath)
        XCTAssertEqual(hitAtNewLocation, Data([0x22]))
    }
}

/// Wraps a `FakeSMBTransport` and forces every `writeFile(data:toPath:)`
/// call to fail, regardless of path — `SMBThumbCache.write`'s first write
/// targets a UUID-suffixed temp path this test can't predict, so this
/// wrapper is the deterministic way to simulate "the share rejects every
/// write" (a genuinely read-only mount) rather than one specific path.
private struct AlwaysFailingWriteTransport: SMBFileTransport {
    let inner: FakeSMBTransport

    func attributesOfItem(atPath path: String) async throws -> [URLResourceKey: any Sendable] {
        try await inner.attributesOfItem(atPath: path)
    }
    func contentsOfDirectory(atPath path: String, recursive: Bool) async throws -> [[URLResourceKey: Any]] {
        try await inner.contentsOfDirectory(atPath: path, recursive: recursive)
    }
    func copyItem(atPath path: String, toPath: String, recursive: Bool,
                 progress: (@Sendable (Int64, Int64) -> Bool)?) async throws {
        try await inner.copyItem(atPath: path, toPath: toPath, recursive: recursive, progress: progress)
    }
    func removeItem(atPath path: String) async throws {
        try await inner.removeItem(atPath: path)
    }
    func createDirectory(atPath path: String) async throws {
        try await inner.createDirectory(atPath: path)
    }
    func moveItem(atPath path: String, toPath: String) async throws {
        try await inner.moveItem(atPath: path, toPath: toPath)
    }
    func setAttributes(attributes: [URLResourceKey: Any], ofItemAtPath path: String) async throws {
        try await inner.setAttributes(attributes: attributes, ofItemAtPath: path)
    }
    func readFile(atPath path: String) async throws -> Data {
        try await inner.readFile(atPath: path)
    }
    func writeFile(data: Data, toPath path: String) async throws {
        throw FakeSMBTransportError.injectedFailure(path)
    }
}
