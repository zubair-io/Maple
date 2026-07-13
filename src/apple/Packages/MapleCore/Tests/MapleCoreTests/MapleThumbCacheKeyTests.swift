import XCTest
@testable import MapleCore

final class MapleThumbCacheKeyTests: XCTestCase {
    /// Parity vector for the API's `sha256Prefix16` (see
    /// `src/api/src/fs/xmp.ts`). Generated server-side via
    /// `node -e "console.log(require('crypto').createHash('sha256').update('IMG_0001.ARW','utf8').digest('hex').slice(0,16))"`.
    /// Both implementations must agree on the exact 16 hex chars for
    /// thumbs written by either layer to be readable by the other.
    func testSha256Prefix16MatchesKnownVector() {
        // Verified: `python3 -c "import hashlib;
        // print(hashlib.sha256(b'IMG_0001.ARW').hexdigest()[:16])"` =>
        // `8fd710b39cdc1a26`.
        XCTAssertEqual(
            MapleThumbCacheKey.sha256Prefix16("IMG_0001.ARW"),
            "8fd710b39cdc1a26"
        )
    }

    func testSha256Prefix16EmptyString() {
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        XCTAssertEqual(
            MapleThumbCacheKey.sha256Prefix16(""),
            "e3b0c44298fc1c14"
        )
    }

    func testSha256Prefix16Length() {
        // 16 hex chars = 8 bytes.
        XCTAssertEqual(MapleThumbCacheKey.sha256Prefix16("abc").count, 16)
        XCTAssertEqual(MapleThumbCacheKey.sha256Prefix16("a longer test string").count, 16)
    }

    func testSha256Prefix16IsLowercase() {
        let h = MapleThumbCacheKey.sha256Prefix16("MixedCase.JPG")
        XCTAssertEqual(h, h.lowercased())
    }

    func testThumbFilenameAlwaysEndsInAvif() {
        XCTAssertTrue(MapleThumbCacheKey.thumbFilename(forRawBasename: "IMG_0001.ARW")
                        .hasSuffix(".avif"))
        XCTAssertTrue(MapleThumbCacheKey.thumbFilename(forRawBasename: "photo.HEIC")
                        .hasSuffix(".avif"))
        XCTAssertTrue(MapleThumbCacheKey.thumbFilename(forRawBasename: "noext")
                        .hasSuffix(".avif"))
    }

    func testThumbFilenameDeterministic() {
        let a = MapleThumbCacheKey.thumbFilename(forRawBasename: "IMG_0001.ARW")
        let b = MapleThumbCacheKey.thumbFilename(forRawBasename: "IMG_0001.ARW")
        XCTAssertEqual(a, b)
    }
}
