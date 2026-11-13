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

  // MARK: - App Group suite + one-time migration (#4717)

  func testLoadMigratesFromTheLegacyStandardDomainOnce() {
    let legacyName = "BackupSettingsTests-legacy-\(UUID().uuidString)"
    let legacy = UserDefaults(suiteName: legacyName)!
    defer { legacy.removePersistentDomain(forName: legacyName) }
    let s = BackupSettings(
      serverURL: "https://srv.example", libraryId: "lib1", rootFolder: "",
      wifiOnly: false, includeLivePhotos: true, includeVideos: true, includeBursts: false,
      includeSharedLibrary: false, includeSharedAlbums: false)
    s.save(to: legacy)

    XCTAssertEqual(BackupSettings.load(from: defaults, migratingFrom: legacy), s)
    XCTAssertEqual(BackupSettings.load(from: defaults), s, "the shared suite now holds the settings")

    var changed = s
    changed.libraryId = "lib2"
    changed.save(to: defaults)
    XCTAssertEqual(
      BackupSettings.load(from: defaults, migratingFrom: legacy), changed,
      "once the shared suite has a value the legacy domain is never consulted again")
  }

  func testStoppedByUserMigratesFromTheLegacyStandardDomain() {
    let legacyName = "BackupSettingsTests-legacy-\(UUID().uuidString)"
    let legacy = UserDefaults(suiteName: legacyName)!
    defer { legacy.removePersistentDomain(forName: legacyName) }
    legacy.set(true, forKey: "maple.backup.stoppedByUser")

    XCTAssertTrue(BackupSettings.isStoppedByUser(in: defaults, migratingFrom: legacy))
    BackupSettings.setStoppedByUser(false, in: defaults)
    XCTAssertFalse(BackupSettings.isStoppedByUser(in: defaults, migratingFrom: legacy))
  }

  func testLoadReturnsNilWhenAbsent() {
    XCTAssertNil(BackupSettings.load(from: defaults))
  }

  func testDefaultsConstructor() {
    let s = BackupSettings.defaults
    XCTAssertEqual(s.rootFolder, "")
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
    s.serverURL = "https://srv.example"
    s.libraryId = "lib1"

    s.includeSharedLibrary = false
    s.save(to: defaults)
    let loaded = BackupSettings.load(from: defaults)
    XCTAssertFalse(
      loaded?.includeSharedLibrary ?? true,
      "includeSharedLibrary=false must survive save/load round-trip")

    s.includeSharedLibrary = true
    s.save(to: defaults)
    let loaded2 = BackupSettings.load(from: defaults)
    XCTAssertTrue(
      loaded2?.includeSharedLibrary ?? false,
      "includeSharedLibrary=true must survive save/load round-trip")
  }

  func testSharedAlbumsToggleRoundTrips() {
    var s = BackupSettings.defaults
    s.serverURL = "https://srv.example"
    s.libraryId = "lib1"

    // Default is false (don't include shared albums).
    XCTAssertFalse(s.includeSharedAlbums)

    s.includeSharedAlbums = true
    s.save(to: defaults)
    let loaded = BackupSettings.load(from: defaults)
    XCTAssertTrue(
      loaded?.includeSharedAlbums ?? false,
      "includeSharedAlbums=true must survive save/load round-trip")
  }

  func testBackupStateIsScopedToDestination() {
    var first = BackupSettings.defaults
    first.serverURL = "https://server.example"
    first.libraryId = "photos"
    var second = first
    second.libraryId = "other"
    XCTAssertNotEqual(first.stateDatabaseFilename, second.stateDatabaseFilename)
    second.libraryId = first.libraryId
    second.serverURL = "https://another.example"
    XCTAssertNotEqual(first.stateDatabaseFilename, second.stateDatabaseFilename)
    second = first
    second.wifiOnly.toggle()
    XCTAssertEqual(first.stateDatabaseFilename, second.stateDatabaseFilename)
  }
}
