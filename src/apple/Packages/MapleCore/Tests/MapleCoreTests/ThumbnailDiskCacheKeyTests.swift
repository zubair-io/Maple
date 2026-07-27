// ThumbnailDiskCacheKeyTests.swift — pins `ThumbnailDiskCache.cacheKey(for:)`
// to the same `sha256(basename)[:16]` derivation used by:
//   - Web (Maple Hosted Angular): src/web/projects/maple-common/src/lib/maple-cache/sha.ts
//   - Server (Bun indexer):       src/api/src/fs/xmp.ts (sha256Prefix16)
//
// Cross-platform parity is a merge gate. If this test ever fails, any thumb
// written by one layer will be invisible to the other two — see issue #108.
//
// #2254: the vectors above only pinned the HASH FUNCTION, never whether the
// code that actually *writes* a thumb agrees with the code that *reads* one
// back. That gap let the server's `thumb` stage drift onto a `<maple_id>.avif`
// destination for months while this suite stayed green (#1999 / PR #2252).
// The "Writer-vs-reader path parity" section below closes the Apple side of
// that hole: it writes through the real `ThumbnailDiskCache` and reads back
// through the independently-implemented `MapleSidecarPaths.thumbURL(for:)`
// (the path `ThumbnailLoader.produceThumbnail` checks before falling back to
// a local decode — see #1365) and asserts they name the exact same file,
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
            ("IMG_0001.ARW",   "8fd710b39cdc1a26"),
            ("test.dng",       "b9011a0233accea2"),
            ("IMG_1234.dng",   "7ad25b268a071d01"),
            ("photo.HEIC",     "db03400ba7adff45"),
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

    // MARK: - Path-vs-basename invariant
    //
    // The same filename in DIFFERENT directories must hash to the SAME key —
    // that's the whole point of basename hashing (so `.maple/` travels with
    // the photos). Pinning this explicitly so a future refactor can't
    // silently switch back to path hashing without failing the test.

    func testSameBasenameDifferentDirsCollideByDesign() {
        let a = URL(fileURLWithPath: "/folder/A/IMG.dng")
        let b = URL(fileURLWithPath: "/folder/B/IMG.dng")
        XCTAssertEqual(
            ThumbnailDiskCache.cacheKey(for: a),
            ThumbnailDiskCache.cacheKey(for: b),
            "basename-keyed cache must collapse identical filenames across dirs — that's correct, see issue #108"
        )
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

    func testStoreWritesFileAtSha256Prefix16Path() async {
        let cache = ThumbnailDiskCache()
        await cache.configure(folderURL: tmp)

        let asset = URL(fileURLWithPath: "/tmp/library/IMG_1234.dng")
        let payload = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46])

        await cache.storeThumbnailData(payload, for: asset)

        let expectedHash = MapleThumbCacheKey.sha256Prefix16("IMG_1234.dng")
        let expectedFile = tmp
            .appendingPathComponent(".maple/thumbs")
            .appendingPathComponent("\(expectedHash).avif")

        XCTAssertTrue(
            FileManager.default.fileExists(atPath: expectedFile.path),
            "expected thumb at \(expectedFile.path); cache key drifted from sha256Prefix16(basename)"
        )

        let onDisk = try? Data(contentsOf: expectedFile)
        XCTAssertEqual(onDisk, payload)
    }

    func testReadByPathMatchesReadByBasename() async {
        let cache = ThumbnailDiskCache()
        await cache.configure(folderURL: tmp)

        // Two different "asset URLs" sharing the same basename — must
        // resolve to the same thumb, because the cache is keyed by basename.
        let writeURL = URL(fileURLWithPath: "/folder/A/IMG_0001.dng")
        let readURL  = URL(fileURLWithPath: "/folder/B/IMG_0001.dng")
        let payload = Data([0x01, 0x02, 0x03, 0x04])

        await cache.storeThumbnailData(payload, for: writeURL)

        let fetched = await cache.thumbnailData(for: readURL)
        XCTAssertEqual(
            fetched, payload,
            "basename-keyed cache should serve any URL with the same lastPathComponent"
        )
    }

    // MARK: - Writer-vs-reader path parity (#2254)
    //
    // `ThumbnailDiskCache` (the writer for locally-generated thumbs) and
    // `MapleSidecarPaths.thumbURL(for:)` (the independent reader
    // `ThumbnailLoader.produceThumbnail` consults first, so a thumb dropped
    // by the API's `thumb` stage or by Web is picked up without a local
    // re-decode) are two SEPARATE implementations that must resolve to the
    // identical on-disk file for the same asset. Asserting only that both
    // reduce to the same hash STEM (as the tests above do) would have missed
    // the #1999 regression, where the divergence was in the DIRECTORY the
    // stem was written under, not the stem itself. This is the Apple sibling
    // of the API's `xmp.test.ts` "agrees with resolveThumbPath for the same
    // file" (added in PR #2252) — same shape: writer's real destination
    // compared to the reader's real resolution, not two calls to the same
    // hash helper.
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

        let expectedHash = MapleThumbCacheKey.sha256Prefix16("IMG_1234.dng")
        let expectedPath = assetDir
            .appendingPathComponent(".maple")
            .appendingPathComponent("thumbs")
            .appendingPathComponent("\(expectedHash).avif")

        XCTAssertEqual(
            readerPath.path, expectedPath.path,
            "MapleSidecarPaths.thumbURL drifted from the pinned <folder>/.maple/thumbs/<stem>.avif convention"
        )
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: readerPath.path),
            "ThumbnailDiskCache wrote somewhere MapleSidecarPaths.thumbURL does not look — " +
            "this is the exact #1999 failure mode (writer/reader path divergence)"
        )
        XCTAssertEqual(
            try? Data(contentsOf: readerPath), payload,
            "file exists at the reader's path but its contents don't match what the writer stored"
        )
    }
}
