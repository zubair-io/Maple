import XCTest
@testable import MapleCore

final class FileProviderMountBookmarkTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "fp-mount-bookmark-test-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testLoadOnEmptyReturnsNil() {
        XCTAssertNil(FileProviderMountBookmark.load(domain: "d1", defaults: defaults))
    }

    func testSaveLoadRoundtrip() {
        let payload = Data([0x01, 0x02, 0x03, 0x04, 0xFE, 0xED])
        FileProviderMountBookmark.save(payload, domain: "d1", defaults: defaults)
        let loaded = FileProviderMountBookmark.load(domain: "d1", defaults: defaults)
        XCTAssertEqual(loaded, payload)
    }

    func testRemoveClearsEntry() {
        FileProviderMountBookmark.save(Data([0xAA]), domain: "d1", defaults: defaults)
        XCTAssertNotNil(FileProviderMountBookmark.load(domain: "d1", defaults: defaults))
        FileProviderMountBookmark.remove(domain: "d1", defaults: defaults)
        XCTAssertNil(FileProviderMountBookmark.load(domain: "d1", defaults: defaults))
    }

    func testPerDomainIsolation() {
        FileProviderMountBookmark.save(Data([0x01]), domain: "d1", defaults: defaults)
        FileProviderMountBookmark.save(Data([0x02]), domain: "d2", defaults: defaults)
        XCTAssertEqual(FileProviderMountBookmark.load(domain: "d1", defaults: defaults), Data([0x01]))
        XCTAssertEqual(FileProviderMountBookmark.load(domain: "d2", defaults: defaults), Data([0x02]))
        FileProviderMountBookmark.remove(domain: "d1", defaults: defaults)
        XCTAssertNil(FileProviderMountBookmark.load(domain: "d1", defaults: defaults))
        XCTAssertEqual(FileProviderMountBookmark.load(domain: "d2", defaults: defaults), Data([0x02]))
    }

    /// Non-security-scoped bookmark roundtrip: tests can't mint
    /// `.withSecurityScope` bookmarks (those require a user-grant flow
    /// like NSOpenPanel), but the plain bookmark path exercises the same
    /// `URL(resolvingBookmarkData:...)` machinery in
    /// `resolveURL(domain:)`.
    func testResolveRoundtripWithPlainBookmark() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("fp-mount-bookmark-resolve-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Plain bookmark — see doc-comment above.
        let bookmark = try tmp.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )

        // Persist via the store, then resolve through it. We override the
        // resolve path's security-scope flag with a manual resolve in a
        // helper-free way: save the bytes, then call resolveURL — on
        // macOS resolveURL passes `.withSecurityScope`, which is
        // incompatible with a plain bookmark, so we exercise the load +
        // bytes-equality path instead and resolve manually for the URL
        // equality assertion.
        FileProviderMountBookmark.save(bookmark, domain: "d1", defaults: defaults)
        let loaded = try XCTUnwrap(FileProviderMountBookmark.load(domain: "d1", defaults: defaults))
        XCTAssertEqual(loaded, bookmark)

        var isStale = false
        let resolved = try URL(
            resolvingBookmarkData: loaded,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
        XCTAssertEqual(resolved.standardizedFileURL.path, tmp.standardizedFileURL.path)
        XCTAssertFalse(isStale)
    }

    /// When the bookmark target no longer exists, resolving still
    /// returns a URL but flags it as stale (or throws, depending on
    /// what the OS decides). We assert "either nil or isStale=true" so
    /// the caller's re-prompt path triggers.
    func testResolveStaleBookmark() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("fp-mount-bookmark-stale-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        let bookmark = try tmp.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        FileProviderMountBookmark.save(bookmark, domain: "d1", defaults: defaults)

        // Delete the directory the bookmark points at.
        try FileManager.default.removeItem(at: tmp)

        // Resolve manually since the production resolveURL uses
        // .withSecurityScope on macOS which is incompatible with our
        // plain test bookmark.
        let loaded = try XCTUnwrap(FileProviderMountBookmark.load(domain: "d1", defaults: defaults))
        var isStale = false
        let resolveResult = Result {
            try URL(
                resolvingBookmarkData: loaded,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
        }
        switch resolveResult {
        case .success:
            // Some platforms return a URL even when the target is gone;
            // assert the staleness flag tripped so the caller would
            // re-prompt.
            XCTAssertTrue(isStale, "expected isStale=true when target is missing")
        case .failure:
            // Other platforms throw — that's an equally valid signal to
            // re-prompt.
            break
        }
    }
}
