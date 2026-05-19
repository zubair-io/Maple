import XCTest
@testable @_spi(MapleTesting) import MapleCore

final class FileProviderMountRouterTests: XCTestCase {

    private let server = URL(string: "https://photos.example.com")!
    private let bookmarkURL = URL(fileURLWithPath: "/private/tmp/maple-fp-mount-test-fixture", isDirectory: true)

    // MARK: - Bookmark present + scope granted → folder view

    func testResolvesToFolderViewWhenBookmarkPresentAndScopeGranted() {
        let route = FileProviderMountRouter.resolve(
            serverURL: server,
            resolver: { _ in (url: self.bookmarkURL, isStale: false) },
            scopeProbe: { _ in true }
        )
        XCTAssertEqual(route, .folderView(bookmarkURL))
    }

    // MARK: - No bookmark → API

    func testResolvesToAPIWhenNoBookmarkStored() {
        let route = FileProviderMountRouter.resolve(
            serverURL: server,
            resolver: { _ in nil },
            scopeProbe: { _ in
                XCTFail("scope probe should not run when no bookmark exists")
                return false
            }
        )
        XCTAssertEqual(route, .apiServer(server))
    }

    // MARK: - Stale bookmark → API

    func testResolvesToAPIWhenBookmarkIsStale() {
        let route = FileProviderMountRouter.resolve(
            serverURL: server,
            resolver: { _ in (url: self.bookmarkURL, isStale: true) },
            scopeProbe: { _ in
                XCTFail("scope probe should not run when bookmark already reports stale")
                return false
            }
        )
        XCTAssertEqual(route, .apiServer(server))
    }

    // MARK: - Scope probe denial → API

    /// Bookmark resolves cleanly but the OS refuses
    /// `startAccessingSecurityScopedResource()` — same fallback path as stale.
    /// Tested separately because the failure modes have different remediation
    /// (re-prompt now vs ignore until next launch).
    func testResolvesToAPIWhenScopeProbeFails() {
        let route = FileProviderMountRouter.resolve(
            serverURL: server,
            resolver: { _ in (url: self.bookmarkURL, isStale: false) },
            scopeProbe: { _ in false }
        )
        XCTAssertEqual(route, .apiServer(server))
    }

    // MARK: - Hostless URL → API

    func testResolvesToAPIWhenServerURLHasNoHost() {
        let bad = URL(string: "file:///not-a-server")!
        let route = FileProviderMountRouter.resolve(
            serverURL: bad,
            resolver: { _ in
                XCTFail("resolver should not run when domain identifier cannot be derived")
                return nil
            },
            scopeProbe: { _ in false }
        )
        XCTAssertEqual(route, .apiServer(bad))
    }

    // MARK: - Domain derivation passes through to resolver

    /// The router must key the resolver lookup on the same domain identifier
    /// `FileProviderDomainController.domainIdentifier(for:)` produces — host
    /// + dash + port. If this drifts, the app will look up bookmarks under
    /// the wrong key after sign-in to a non-standard-port server.
    func testResolverReceivesCanonicalDomainIdentifier() {
        let serverWithPort = URL(string: "http://localhost:3000")!
        var seenDomain: String?
        _ = FileProviderMountRouter.resolve(
            serverURL: serverWithPort,
            resolver: { domain in
                seenDomain = domain
                return nil
            },
            scopeProbe: { _ in false }
        )
        XCTAssertEqual(seenDomain, "localhost-3000")
    }

    // MARK: - isBookmarkBroken

    func testIsBookmarkBrokenFalseWhenNoBookmark() {
        let broken = FileProviderMountRouter.isBookmarkBroken(
            serverURL: server,
            resolver: { _ in nil },
            scopeProbe: { _ in false }
        )
        XCTAssertFalse(broken)
    }

    func testIsBookmarkBrokenFalseWhenBookmarkWorks() {
        let broken = FileProviderMountRouter.isBookmarkBroken(
            serverURL: server,
            resolver: { _ in (url: self.bookmarkURL, isStale: false) },
            scopeProbe: { _ in true }
        )
        XCTAssertFalse(broken)
    }

    func testIsBookmarkBrokenTrueWhenStale() {
        let broken = FileProviderMountRouter.isBookmarkBroken(
            serverURL: server,
            resolver: { _ in (url: self.bookmarkURL, isStale: true) },
            scopeProbe: { _ in false }
        )
        XCTAssertTrue(broken)
    }

    func testIsBookmarkBrokenTrueWhenScopeProbeFails() {
        let broken = FileProviderMountRouter.isBookmarkBroken(
            serverURL: server,
            resolver: { _ in (url: self.bookmarkURL, isStale: false) },
            scopeProbe: { _ in false }
        )
        XCTAssertTrue(broken)
    }
}
