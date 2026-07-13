// ThumbnailDiskCacheKeyTests.swift — pins `ThumbnailDiskCache.cacheKey(for:)`
// to the same `sha256(basename)[:16]` derivation used by:
//   - Web (Maple Hosted Angular): src/web/projects/maple-common/src/lib/maple-cache/sha.ts
//   - Server (Bun indexer):       src/api/src/fs/xmp.ts (sha256Prefix16)
//
// Cross-platform parity is a merge gate. If this test ever fails, any thumb
// written by one layer will be invisible to the other two — see issue #108.

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
}
