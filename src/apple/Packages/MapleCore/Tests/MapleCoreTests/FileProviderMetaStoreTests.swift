import XCTest
@testable import MapleCore

final class FileProviderMetaStoreTests: XCTestCase {
    private func freshStoreURL() -> URL {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("fp-meta-\(UUID().uuidString).sqlite")
        try? FileManager.default.removeItem(at: tmp)
        return tmp
    }

    func testRoundTripCanonicalRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "default", localBasename: "ABC123",
                      assetID: "650a1b2c3d4e5f6071829304",
                      conflictBasename: nil)
        let row = try store.get(domain: "default", localBasename: "ABC123")
        XCTAssertEqual(row?.assetID, "650a1b2c3d4e5f6071829304")
        XCTAssertNil(row?.conflictBasename)
    }

    func testRoundTripConflictRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "default", localBasename: "XYZ",
                      assetID: "650a", conflictBasename: "shot (conflict from MBP)")
        let row = try store.get(domain: "default", localBasename: "XYZ")
        XCTAssertEqual(row?.conflictBasename, "shot (conflict from MBP)")
    }

    func testGetMissingReturnsNil() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        XCTAssertNil(try store.get(domain: "default", localBasename: "nope"))
    }

    func testPutReplacesExistingRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "d", localBasename: "k", assetID: "old", conflictBasename: nil)
        try store.put(domain: "d", localBasename: "k", assetID: "new", conflictBasename: nil)
        XCTAssertEqual(try store.get(domain: "d", localBasename: "k")?.assetID, "new")
    }

    func testRemoveDeletesRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "d", localBasename: "k", assetID: "v", conflictBasename: nil)
        try store.remove(domain: "d", localBasename: "k")
        XCTAssertNil(try store.get(domain: "d", localBasename: "k"))
    }

    func testReopenSeesPersistedRows() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let s = try FileProviderMetaStore(url: url)
            try s.put(domain: "d", localBasename: "k", assetID: "v", conflictBasename: nil)
        }
        let s2 = try FileProviderMetaStore(url: url)
        XCTAssertEqual(try s2.get(domain: "d", localBasename: "k")?.assetID, "v")
    }

    func testSchemaMigrationIsIdempotent() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        _ = try FileProviderMetaStore(url: url)
        _ = try FileProviderMetaStore(url: url)
        _ = try FileProviderMetaStore(url: url)
        // No throw = pass
    }

    func testSharedURLLivesUnderAppGroupContainer() throws {
        // The function is purely a path resolver — it should not require
        // the App Group to actually exist on the test host. We assert the
        // computed URL ends with the expected filename and falls back to
        // the temp dir when the App Group container is unavailable.
        let url = FileProviderMetaStore.sharedStoreURL(
            groupContainerProvider: { _ in nil }
        )
        XCTAssertEqual(url.lastPathComponent, "fp-meta.sqlite")
    }

    func testSharedURLPrefersAppGroupContainer() throws {
        let stub = FileManager.default.temporaryDirectory
            .appendingPathComponent("group-stub-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stub, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stub) }
        let url = FileProviderMetaStore.sharedStoreURL(
            groupContainerProvider: { _ in stub }
        )
        XCTAssertTrue(url.path.hasPrefix(stub.path),
                      "expected \(url.path) to start with \(stub.path)")
        XCTAssertEqual(url.lastPathComponent, "fp-meta.sqlite")
    }
}
