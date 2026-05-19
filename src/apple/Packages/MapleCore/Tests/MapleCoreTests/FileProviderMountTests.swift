import FileProvider
import XCTest
@testable import MapleCore

final class FileProviderMountTests: XCTestCase {

    // MARK: - domain(forServer:)

    /// `domain(forServer:)` returns nil when no FP domain is registered
    /// for the server. Uses a UUID-derived host so the test can't
    /// accidentally collide with a domain the developer actually
    /// registered. Skips when the host CI/dev box has FP domains disabled
    /// (`MAPLE_SKIP_FP_INTEGRATION=1` or `NSFileProviderManager.domains()`
    /// throws) — this is a true OS-state integration test.
    func testDomainForServerReturnsNilWhenUnregistered() async throws {
        if ProcessInfo.processInfo.environment["MAPLE_SKIP_FP_INTEGRATION"] == "1" {
            throw XCTSkip("MAPLE_SKIP_FP_INTEGRATION=1 — skipping FP domain probe")
        }
        let randomHost = "fp-mount-test-\(UUID().uuidString.lowercased()).invalid"
        let url = URL(string: "https://\(randomHost):65535")!
        do {
            let domain = try await FileProviderMount.domain(forServer: url)
            XCTAssertNil(domain, "Random unused server URL must not have a registered FP domain")
        } catch {
            // The OS-side enumeration may fail on a CI runner with no FP
            // entitlement. Treat that as a skip — the negative-case
            // assertion above is the only thing this test can verify
            // without OS-side setup.
            throw XCTSkip("NSFileProviderManager.domains() unavailable: \(error)")
        }
    }

    func testDomainForServerReturnsNilForHostlessURL() async throws {
        let url = URL(fileURLWithPath: "/tmp/not-a-server")
        let domain = try await FileProviderMount.domain(forServer: url)
        XCTAssertNil(domain)
    }

    // MARK: - composePath / relativePath (pure)

    func testComposePathHappyPath() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.composePath(
            mountURL: mount,
            rootLabel: "Library",
            absPath: "/srv/photos/Library/2026/Adam/04-02/IMG.dng",
            rootPath: "/srv/photos/Library"
        )
        XCTAssertEqual(
            url?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Library/2026/Adam/04-02/IMG.dng"
        )
    }

    func testComposePathReturnsNilWhenAbsPathOutsideRoot() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.composePath(
            mountURL: mount,
            rootLabel: "Library",
            absPath: "/srv/photos/OtherLibrary/IMG.dng",
            rootPath: "/srv/photos/Library"
        )
        XCTAssertNil(url, "absPath outside root must yield nil")
    }

    /// Defensive: absPath that *prefixes* the root path string but is in
    /// a different directory (no trailing slash separator) must NOT match.
    func testComposePathRejectsSiblingDirectoryPrefix() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        // "/srv/photos/LibraryB/IMG.dng" starts with "/srv/photos/Library"
        // as a substring but is a different folder — must not match.
        let url = FileProviderMount.composePath(
            mountURL: mount,
            rootLabel: "Library",
            absPath: "/srv/photos/LibraryB/IMG.dng",
            rootPath: "/srv/photos/Library"
        )
        XCTAssertNil(url, "sibling directory whose name happens to begin with root must not match")
    }

    func testComposePathReturnsNilForEmptyAbsPath() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.composePath(
            mountURL: mount,
            rootLabel: "Library",
            absPath: "",
            rootPath: "/srv/photos/Library"
        )
        XCTAssertNil(url, "empty absPath must yield nil")
    }

    /// Root path with vs without trailing slash must produce identical
    /// output. The shared `relativePath` normaliser owns this.
    func testComposePathTrailingSlashAgnostic() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let abs = "/srv/photos/Library/2026/IMG.dng"
        let without = FileProviderMount.composePath(
            mountURL: mount,
            rootLabel: "Library",
            absPath: abs,
            rootPath: "/srv/photos/Library"
        )
        let with = FileProviderMount.composePath(
            mountURL: mount,
            rootLabel: "Library",
            absPath: abs,
            rootPath: "/srv/photos/Library/"
        )
        XCTAssertEqual(without?.path, with?.path)
        XCTAssertEqual(
            without?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Library/2026/IMG.dng"
        )
    }

    /// Multi-component relative path must be decomposed into individual
    /// `appendingPathComponent` calls so `URL`'s behaviour with embedded
    /// slashes can't quietly change the result.
    func testComposePathHandlesDeepRelativePath() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.composePath(
            mountURL: mount,
            rootLabel: "Photos",
            absPath: "/srv/photos/Library/a/b/c/d/IMG.dng",
            rootPath: "/srv/photos/Library"
        )
        XCTAssertEqual(
            url?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Photos/a/b/c/d/IMG.dng"
        )
        // Ensure each path segment is its own URL component (not a single
        // slash-containing component) — guards against silent regression
        // if the composer ever reverts to passing the whole relative
        // string into one appendingPathComponent call.
        let suffix = Array(url?.pathComponents.suffix(5) ?? [])
        XCTAssertEqual(suffix, ["a", "b", "c", "d", "IMG.dng"])
    }

    // MARK: - relativePath (pure helper)

    func testRelativePathStripsRootPrefix() {
        XCTAssertEqual(
            FileProviderMount.relativePath(under: "/srv/lib", of: "/srv/lib/a/b.dng"),
            "a/b.dng"
        )
    }

    func testRelativePathNilWhenOutsideRoot() {
        XCTAssertNil(FileProviderMount.relativePath(under: "/srv/lib", of: "/srv/other/a.dng"))
    }

    func testRelativePathNilForEmptyInputs() {
        XCTAssertNil(FileProviderMount.relativePath(under: "", of: "/srv/lib/a.dng"))
        XCTAssertNil(FileProviderMount.relativePath(under: "/srv/lib", of: ""))
    }

    // MARK: - localURL(forServerPath:rootPath:rootLabel:mountURL:)

    /// Server path equal to the registered root opens at the library
    /// folder under the mount, NOT the bare mount root. This is the
    /// multi-library-server case — different libraries must route to
    /// different subdirectories under the same FP mount.
    func testLocalURLForServerPathRootMapsToLabeledSubdir() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library",
            rootPath: "/srv/photos/Library",
            rootLabel: "Library",
            mountURL: mount
        )
        XCTAssertEqual(
            url?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Library"
        )
    }

    func testLocalURLForServerPathOneLevelDeep() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library/2026",
            rootPath: "/srv/photos/Library",
            rootLabel: "Library",
            mountURL: mount
        )
        XCTAssertEqual(
            url?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Library/2026"
        )
    }

    func testLocalURLForServerPathSeveralLevelsDeep() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library/2026/Camping/Day1",
            rootPath: "/srv/photos/Library",
            rootLabel: "Photos",
            mountURL: mount
        )
        XCTAssertEqual(
            url?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Photos/2026/Camping/Day1"
        )
        // Each segment must be its own path component — guard against a
        // regression that passes the whole relative string into one
        // appendingPathComponent call.
        let suffix = Array(url?.pathComponents.suffix(4) ?? [])
        XCTAssertEqual(suffix, ["Photos", "2026", "Camping", "Day1"])
    }

    func testLocalURLForServerPathOffTreeReturnsNil() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.localURL(
            forServerPath: "/srv/photos/OtherLibrary/2026",
            rootPath: "/srv/photos/Library",
            rootLabel: "Library",
            mountURL: mount
        )
        XCTAssertNil(url, "server path outside the registered root must yield nil")
    }

    /// Sibling-directory whose name *prefixes* the root path as a string
    /// must NOT match. Same defensive prefix-strip semantics as
    /// `composePath` / `relativePath`.
    func testLocalURLRejectsSiblingDirectoryPrefix() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.localURL(
            forServerPath: "/srv/photos/LibraryB/2026",
            rootPath: "/srv/photos/Library",
            rootLabel: "Library",
            mountURL: mount
        )
        XCTAssertNil(url)
    }

    /// Trailing-slash variations on `serverPath` must produce the same
    /// result. The server's path canonicalisation isn't uniform across
    /// every endpoint.
    func testLocalURLTrailingSlashAgnostic() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let without = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library/2026",
            rootPath: "/srv/photos/Library",
            rootLabel: "Library",
            mountURL: mount
        )
        let with = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library/2026/",
            rootPath: "/srv/photos/Library",
            rootLabel: "Library",
            mountURL: mount
        )
        XCTAssertEqual(without?.path, with?.path)
        XCTAssertEqual(
            without?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Library/2026"
        )
    }

    /// Same agnosticism for the root path side — `/srv/lib` and
    /// `/srv/lib/` must produce identical output.
    func testLocalURLTrailingSlashAgnosticOnRoot() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let withoutRootSlash = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library/2026",
            rootPath: "/srv/photos/Library",
            rootLabel: "Library",
            mountURL: mount
        )
        let withRootSlash = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library/2026",
            rootPath: "/srv/photos/Library/",
            rootLabel: "Library",
            mountURL: mount
        )
        XCTAssertEqual(withoutRootSlash?.path, withRootSlash?.path)
    }

    /// Server path equal to root with a trailing slash must round-trip
    /// to the same library URL.
    func testLocalURLForServerPathRootWithTrailingSlash() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library/",
            rootPath: "/srv/photos/Library",
            rootLabel: "Library",
            mountURL: mount
        )
        XCTAssertEqual(
            url?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Library"
        )
    }

    func testLocalURLReturnsNilForEmptyServerPath() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        XCTAssertNil(FileProviderMount.localURL(
            forServerPath: "",
            rootPath: "/srv/photos/Library",
            rootLabel: "Library",
            mountURL: mount
        ))
    }

    func testLocalURLReturnsNilForEmptyRootPath() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        XCTAssertNil(FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library/2026",
            rootPath: "",
            rootLabel: "Library",
            mountURL: mount
        ))
    }

    /// PR #110 review (Copilot): `CloudFolder.label` is allowed to be empty.
    /// When it is, the helper must NOT collapse onto bare `mountURL` (which
    /// would silently merge multi-library servers into one directory) —
    /// derive the subdirectory from `rootPath`'s last segment instead,
    /// matching the `CloudFolder.displayName` fallback contract.
    func testLocalURLDerivesSubdirFromRootPathWhenLabelIsEmpty() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library/2026",
            rootPath: "/srv/photos/Library",
            rootLabel: "",
            mountURL: mount
        )
        XCTAssertEqual(
            url?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Library/2026"
        )
    }

    /// Companion to the deepest-fallback test: when caller passes an empty
    /// label AND the server path equals the root, derived label still
    /// applies (no path translation, just label resolution).
    func testLocalURLDerivesSubdirFromRootPathWhenLabelIsEmptyAndServerEqualsRoot() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        let url = FileProviderMount.localURL(
            forServerPath: "/srv/photos/Library",
            rootPath: "/srv/photos/Library",
            rootLabel: "",
            mountURL: mount
        )
        XCTAssertEqual(
            url?.path,
            "/Users/u/Library/CloudStorage/Maple-Server/Library"
        )
    }

    /// Empty label + filesystem-root path is unrecoverable — multi-library
    /// at `/` would have no way to disambiguate. The helper returns nil
    /// rather than collapsing onto the bare mount URL.
    func testLocalURLReturnsNilWhenLabelEmptyAndRootIsFilesystemRoot() {
        let mount = URL(fileURLWithPath: "/Users/u/Library/CloudStorage/Maple-Server")
        XCTAssertNil(FileProviderMount.localURL(
            forServerPath: "/Library",
            rootPath: "/",
            rootLabel: "",
            mountURL: mount
        ))
    }
}
