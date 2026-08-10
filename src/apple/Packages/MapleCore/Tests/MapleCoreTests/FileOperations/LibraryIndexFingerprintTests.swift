// LibraryIndexFingerprintTests.swift — issue #2656 review follow-up:
// `LibraryEntry.fingerprintAttempted` is a schema addition to a
// JSON-persisted type (`.maple/index.json`), so decoding an OLDER file
// that predates this field (and, one commit further back, the whole
// fingerprint trio) must still succeed. Real temp-dir files — no mocks.

import XCTest
@testable import MapleCore

final class LibraryIndexFingerprintTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        super.setUp()
        root = FileOperationsTestSupport.makeTempDir()
    }

    override func tearDown() {
        FileOperationsTestSupport.cleanup(root)
        root = nil
        super.tearDown()
    }

    /// A hand-written `index.json` in the shape written before #2656 ever
    /// existed — no `dateTimeOriginal`/`cameraSerial`/`fingerprintAttempted`
    /// keys at all. `LibraryEntry`'s three fingerprint fields are all
    /// `Optional`, so `Codable`'s synthesized `init(from:)` must decode a
    /// missing key as `nil` without throwing.
    func testDecodesAnIndexFileWrittenBeforeFingerprintFieldsExisted() async throws {
        let mapleDir = root.appendingPathComponent(".maple")
        try FileManager.default.createDirectory(at: mapleDir, withIntermediateDirectories: true)
        let indexURL = mapleDir.appendingPathComponent("index.json")
        let legacyJSON = """
        {
          "version" : 1,
          "folderURL" : "\(root.path)",
          "lastUpdated" : "2026-01-01T00:00:00Z",
          "entries" : {
            "IMG_1.dng" : {
              "name" : "IMG_1.dng",
              "stars" : 3,
              "flag" : "pick"
            }
          }
        }
        """
        try legacyJSON.write(to: indexURL, atomically: true, encoding: .utf8)

        let store = LibraryIndexStore(folderURL: root)
        let index = try await store.load()

        let entry = try XCTUnwrap(index?.entries["IMG_1.dng"])
        XCTAssertEqual(entry.stars, 3)
        XCTAssertEqual(entry.flag, "pick")
        XCTAssertNil(entry.dateTimeOriginal)
        XCTAssertNil(entry.cameraSerial)
        XCTAssertNil(entry.fingerprintAttempted)
    }

    /// A file written by the FIRST #2656 commit — `dateTimeOriginal`/
    /// `cameraSerial` exist but `fingerprintAttempted` doesn't yet. Must
    /// also decode cleanly, with the new field `nil`.
    func testDecodesAnIndexFileWrittenBeforeFingerprintAttemptedExisted() async throws {
        let mapleDir = root.appendingPathComponent(".maple")
        try FileManager.default.createDirectory(at: mapleDir, withIntermediateDirectories: true)
        let indexURL = mapleDir.appendingPathComponent("index.json")
        let midJSON = """
        {
          "version" : 1,
          "folderURL" : "\(root.path)",
          "lastUpdated" : "2026-01-01T00:00:00Z",
          "entries" : {
            "IMG_1.dng" : {
              "name" : "IMG_1.dng",
              "stars" : 0,
              "flag" : "none",
              "size" : 12345,
              "dateTimeOriginal" : "2026:01:01 00:00:00"
            }
          }
        }
        """
        try midJSON.write(to: indexURL, atomically: true, encoding: .utf8)

        let store = LibraryIndexStore(folderURL: root)
        let index = try await store.load()

        let entry = try XCTUnwrap(index?.entries["IMG_1.dng"])
        XCTAssertEqual(entry.dateTimeOriginal, "2026:01:01 00:00:00")
        XCTAssertNil(entry.fingerprintAttempted)
    }

    // MARK: - updateFingerprints stamps fingerprintAttempted

    func testUpdateFingerprintsStampsFingerprintAttemptedTrueEvenWithoutExif() async throws {
        let store = LibraryIndexStore(folderURL: root)
        try await store.updateFingerprints([
            LibraryIndexStore.FingerprintUpdate(
                name: "screenshot.png", size: 500, mtime: nil, dateTimeOriginal: nil, cameraSerial: nil),
        ])

        let index = try await store.load()
        let entry = try XCTUnwrap(index?.entries["screenshot.png"])
        XCTAssertNil(entry.dateTimeOriginal)
        XCTAssertEqual(entry.fingerprintAttempted, true, "a recorded attempt must be stamped even with no EXIF")
    }
}
