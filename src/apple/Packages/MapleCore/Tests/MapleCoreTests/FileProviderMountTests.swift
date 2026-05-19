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
}
