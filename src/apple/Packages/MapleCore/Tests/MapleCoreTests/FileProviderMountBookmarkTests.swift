import XCTest
@testable @_spi(MapleTesting) import MapleCore

final class FileProviderMountBookmarkTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "fp-mount-bookmark-test-\(UUID().uuidString)"
        // `UserDefaults(suiteName:)` returns optional. Force-unwrap with a
        // clear message: a transient-suite construction failure here is a
        // test-environment problem, not an expected production path.
        guard let d = UserDefaults(suiteName: suiteName) else {
            fatalError("UserDefaults(suiteName: \(suiteName!)) returned nil — test environment cannot create transient suites")
        }
        defaults = d
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

    /// Contract test for the missing-target re-prompt path in
    /// `_resolve(bookmark:options:domain:)`. On macOS the OS itself
    /// throws `NSCocoaErrorDomain code 4 ("file doesn't exist")` for
    /// plain bookmarks against a deleted dir — that's caught and the
    /// call returns `nil` (a valid re-prompt signal). We can't reach
    /// the post-resolve `fileExists` branch in a unit test because no
    /// fixture-friendly bookmark variant produces the "resolved but
    /// gone" condition the security-scoped production path occasionally
    /// hits. The assertion is therefore "nil OR isStale=true, never a
    /// silent success" — the production branch is a defensive guard
    /// against the security-scoped behaviour observed in the field.
    func testResolveOnDeletedTargetForcesIsStale() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("fp-mount-bookmark-deleted-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        let bookmark = try tmp.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        try FileManager.default.removeItem(at: tmp)

        let resolved = FileProviderMountBookmark._resolve(
            bookmark: bookmark,
            options: [],
            domain: "d1"
        )
        // Either: the resolve threw and we got nil (also a valid re-prompt
        // signal), or it succeeded and our fileExists check tripped
        // isStale = true. The bug we're guarding against is "URL returned,
        // isStale = false, target missing".
        if let resolved {
            XCTAssertTrue(
                resolved.isStale,
                "resolve returned a URL for a deleted target without flagging isStale — caller would mistakenly trust it"
            )
        }
    }
}
