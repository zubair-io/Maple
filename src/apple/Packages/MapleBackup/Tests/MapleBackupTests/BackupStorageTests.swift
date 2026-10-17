// BackupStorageTests.swift — #4717.
//
// The backup state DB, the PhotoKit sidecar store and the device id used
// to live in each process's OWN Application Support, so the macOS backup
// helper (a separate process) never saw what the app wrote. They now
// resolve inside the shared App Group container, with a one-time move of
// whatever the old per-process location already holds.

import XCTest
@testable import MapleBackup

final class BackupStorageTests: XCTestCase {
    private func tempDir(_ name: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testResolvesInsideTheAppGroupContainerWhenAvailable() throws {
        let container = try tempDir("group")
        let legacy = try tempDir("legacy")

        let root = try BackupStorage.resolveRoot(container: container, legacy: legacy)

        XCTAssertEqual(root, container.appendingPathComponent("Maple", isDirectory: true))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.path))
    }

    func testFallsBackToTheLegacyLocationWithoutAContainer() throws {
        let legacy = try tempDir("legacy")

        let root = try BackupStorage.resolveRoot(container: nil, legacy: legacy)

        XCTAssertEqual(root, legacy)
    }

    func testMovesExistingPerProcessStateIntoTheSharedRootOnce() throws {
        let container = try tempDir("group")
        let legacy = try tempDir("legacy")
        try "DEV-1".write(to: legacy.appendingPathComponent("device-id"), atomically: true, encoding: .utf8)
        let sidecars = legacy.appendingPathComponent("PhotoKitSidecars", isDirectory: true)
        try FileManager.default.createDirectory(at: sidecars, withIntermediateDirectories: true)
        try "<xmp/>".write(to: sidecars.appendingPathComponent("a.xmp"), atomically: true, encoding: .utf8)
        try Data("db".utf8).write(to: legacy.appendingPathComponent("backup-state-abc.sqlite"))

        let root = try BackupStorage.resolveRoot(container: container, legacy: legacy)

        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("device-id"), encoding: .utf8), "DEV-1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("PhotoKitSidecars/a.xmp").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("backup-state-abc.sqlite").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.appendingPathComponent("device-id").path),
                       "moved, not copied — two processes must never diverge again")

        // A second resolve is a no-op and never clobbers what the shared
        // root now holds, even if something reappears at the old path.
        try "DEV-STALE".write(to: legacy.appendingPathComponent("device-id"), atomically: true, encoding: .utf8)
        _ = try BackupStorage.resolveRoot(container: container, legacy: legacy)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("device-id"), encoding: .utf8), "DEV-1")
    }

    func testDerivedLocationsHangOffTheResolvedRoot() throws {
        let root = try tempDir("root")

        XCTAssertEqual(DeviceIdentity.storageURL(in: root), root.appendingPathComponent("device-id"))
        XCTAssertEqual(
            try AppSupportSidecarStore.defaultRoot(in: root),
            root.appendingPathComponent("PhotoKitSidecars", isDirectory: true))
        XCTAssertEqual(
            BackupStorage.stateDatabaseURL(in: root, filename: "backup-state-x.sqlite"),
            root.appendingPathComponent("backup-state-x.sqlite"))
    }
}
