import XCTest
import CoreImage
@testable import MapleCore

final class DecodedBufferCacheTests: XCTestCase {
    func testStoreAndFetchRoundTripsData() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Create a fake "asset" file the cache can mtime-key against.
        let assetURL = tmp.appendingPathComponent("fake.dng")
        try Data([0, 1, 2, 3]).write(to: assetURL)

        let cache = DecodedBufferCache()
        await cache.configure(folderURL: tmp)

        // Create a small test CIImage.
        let ci = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))

        await cache.storeDecoded(ci, for: assetURL)
        let fetched = await cache.decoded(for: assetURL)
        XCTAssertNotNil(fetched)
    }

    func testMissReturnsNil() async {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
        let cache = DecodedBufferCache()
        await cache.configure(folderURL: tmp)
        let assetURL = tmp.appendingPathComponent("nonexistent.dng")
        let fetched = await cache.decoded(for: assetURL)
        XCTAssertNil(fetched)
    }
}
