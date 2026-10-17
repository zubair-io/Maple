import XCTest

@testable import MapleCore

final class BackupSettingsMigrationTests: XCTestCase {
  func testAppSettingsReachSeparateAgentProcessAndMigrateOnlyOnce() throws {
    if let suite = ProcessInfo.processInfo.environment["MAPLE_BACKUP_TEST_SUITE"] {
      let shared = try XCTUnwrap(UserDefaults(suiteName: suite))
      let settings = try XCTUnwrap(BackupSettings.load(from: shared))
      XCTAssertEqual(settings.serverURL, "https://backup.example")
      XCTAssertEqual(settings.libraryId, "library")
      XCTAssertTrue(shared.bool(forKey: "maple.backup.stoppedByUser"))
      return
    }
    let legacyName = "BackupLegacy-\(UUID().uuidString)"
    let sharedName = "BackupShared-\(UUID().uuidString)"
    let legacy = UserDefaults(suiteName: legacyName)!
    let shared = UserDefaults(suiteName: sharedName)!
    defer {
      legacy.removePersistentDomain(forName: legacyName)
      shared.removePersistentDomain(forName: sharedName)
    }
    var settings = BackupSettings.defaults
    settings.serverURL = "https://backup.example"
    settings.libraryId = "library"
    settings.save(to: legacy)
    legacy.set(true, forKey: "maple.backup.stoppedByUser")
    var prepared = false
    try BackupSettings.migrate(from: legacy, to: shared) {
      XCTAssertNil(BackupSettings.load(from: shared))
      prepared = true
    }
    XCTAssertTrue(prepared)
    XCTAssertEqual(BackupSettings.load(from: shared), settings)
    XCTAssertTrue(shared.bool(forKey: "maple.backup.stoppedByUser"))
    // A fresh process has no app in-memory defaults cache.
    XCTAssertTrue(shared.synchronize())
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = [
      "-XCTest",
      "MapleCoreTests.BackupSettingsMigrationTests/testAppSettingsReachSeparateAgentProcessAndMigrateOnlyOnce",
      Bundle(for: BackupSettingsMigrationTests.self).bundlePath,
    ]
    var environment = ProcessInfo.processInfo.environment
    environment["MAPLE_BACKUP_TEST_SUITE"] = sharedName
    process.environment = environment
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    settings.libraryId = "new destination"
    settings.save(to: shared)
    try BackupSettings.migrate(from: legacy, to: shared) {
      XCTFail("A legacy configuration must never overwrite the shared destination")
    }
    XCTAssertEqual(BackupSettings.load(from: shared), settings)
  }

  func testStorageFailureDoesNotPublishLegacySettings() throws {
    let legacyName = "BackupLegacy-\(UUID().uuidString)"
    let sharedName = "BackupShared-\(UUID().uuidString)"
    let legacy = UserDefaults(suiteName: legacyName)!
    let shared = UserDefaults(suiteName: sharedName)!
    defer {
      legacy.removePersistentDomain(forName: legacyName)
      shared.removePersistentDomain(forName: sharedName)
    }
    BackupSettings.defaults.save(to: legacy)
    XCTAssertThrowsError(
      try BackupSettings.migrate(from: legacy, to: shared) {
        throw CocoaError(.fileWriteNoPermission)
      })
    XCTAssertNil(BackupSettings.load(from: shared))
    XCTAssertNotNil(BackupSettings.load(from: legacy))
  }
}
