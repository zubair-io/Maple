import XCTest
@testable import MapleCore

final class BackupSettingsTests: XCTestCase {
    private let suiteName = "BackupSettingsTests-\(UUID().uuidString)"
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
    }

    func testSaveAndLoadRoundTrip() {
        let s = BackupSettings(
            serverURL: "https://srv.example",
            libraryId: "lib1",
            rootFolder: "Photos/",
            wifiOnly: true,
            includeLivePhotos: true,
            includeVideos: true,
            includeBursts: false,
            includeSharedLibrary: true,
            includeSharedAlbums: false)
        s.save(to: defaults)
        let loaded = BackupSettings.load(from: defaults)
        XCTAssertEqual(loaded, s)
    }

    func testLoadReturnsNilWhenAbsent() {
        XCTAssertNil(BackupSettings.load(from: defaults))
    }

    func testDefaultsConstructor() {
        let s = BackupSettings.defaults
        XCTAssertEqual(s.rootFolder, "Photos/")
        XCTAssertTrue(s.wifiOnly)
        XCTAssertTrue(s.includeLivePhotos)
        XCTAssertTrue(s.includeVideos)
        XCTAssertFalse(s.includeBursts)
        XCTAssertTrue(s.includeSharedLibrary)
        XCTAssertFalse(s.includeSharedAlbums)
    }

    func testIsConfiguredRequiresServerAndLibrary() {
        let empty = BackupSettings.defaults
        XCTAssertFalse(empty.isConfigured)
        var partial = BackupSettings.defaults
        partial.serverURL = "https://srv.example"
        XCTAssertFalse(partial.isConfigured)
        partial.libraryId = "lib1"
        XCTAssertTrue(partial.isConfigured)
    }

    func testSharedLibraryToggleRoundTrips() {
        var s = BackupSettings.defaults
        s.serverURL = "https://srv.example"; s.libraryId = "lib1"

        s.includeSharedLibrary = false
        s.save(to: defaults)
        let loaded = BackupSettings.load(from: defaults)
        XCTAssertFalse(loaded?.includeSharedLibrary ?? true,
                       "includeSharedLibrary=false must survive save/load round-trip")

        s.includeSharedLibrary = true
        s.save(to: defaults)
        let loaded2 = BackupSettings.load(from: defaults)
        XCTAssertTrue(loaded2?.includeSharedLibrary ?? false,
                      "includeSharedLibrary=true must survive save/load round-trip")
    }

    func testSharedAlbumsToggleRoundTrips() {
        var s = BackupSettings.defaults
        s.serverURL = "https://srv.example"; s.libraryId = "lib1"

        // Default is false (don't include shared albums).
        XCTAssertFalse(s.includeSharedAlbums)

        s.includeSharedAlbums = true
        s.save(to: defaults)
        let loaded = BackupSettings.load(from: defaults)
        XCTAssertTrue(loaded?.includeSharedAlbums ?? false,
                      "includeSharedAlbums=true must survive save/load round-trip")
    }
}
