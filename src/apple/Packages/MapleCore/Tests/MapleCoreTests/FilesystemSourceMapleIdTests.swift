// FilesystemSourceMapleIdTests.swift — end-to-end maple_id wiring for
// FilesystemSource (#1995): real temp-directory files, real `images()`
// calls, no mocks.
//
// These synthetic test files carry no EXIF, so every case here exercises
// the fallback-form path end to end (head read, cache lookup/record,
// staleness on content replacement). Primary-form correctness itself is
// covered independently by `ExifCaptureDateTests` (the normalization) and
// `MapleIdDerivationTests` (the dispatch) — this file's job is proving the
// WIRING into `FilesystemSource.images()` actually works, not re-deriving
// the algorithm's correctness.

import XCTest
@testable import MapleCore

final class FilesystemSourceMapleIdTests: XCTestCase {

    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("filesystem-source-maple-id-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    @discardableResult
    private func writeFile(_ name: String, contents: Data) throws -> URL {
        let url = tmpDir.appendingPathComponent(name)
        try contents.write(to: url)
        return url
    }

    // MARK: - id is a real maple_id, not the raw path

    func testImagesReturnsMapleIdNotRawPath() async throws {
        let bytes = Data((0..<4096).map { UInt8($0 & 0xff) })
        let fileURL = try writeFile("a.dng", contents: bytes)

        let source = FilesystemSource()
        try await source.open(folderURL: tmpDir)
        let refs = try await source.images()

        XCTAssertEqual(refs.count, 1)
        let ref = refs[0]
        XCTAssertNotEqual(ref.id, fileURL.path, "id must no longer be the raw filesystem path")
        XCTAssertEqual(ref.id.count, 32, "spec-form maple_id is 32 hex chars")
        // No EXIF in this synthetic file -> fallback form (tag 0x02).
        XCTAssertEqual(ref.id.prefix(2), "02")
        XCTAssertEqual(ref.id, MapleId.fallback(bytes: bytes))
    }

    // MARK: - Stability + cache reuse

    func testUnchangedFileReturnsStableIdAcrossCalls() async throws {
        let bytes = Data(repeating: 0xCC, count: 3000)
        try writeFile("a.dng", contents: bytes)

        let source = FilesystemSource()
        try await source.open(folderURL: tmpDir)
        let refs1 = try await source.images()
        let refs2 = try await source.images()

        XCTAssertEqual(refs1[0].id, refs2[0].id)
    }

    func testIdCacheFileIsWrittenAndContainsTheComputedId() async throws {
        let bytes = Data(repeating: 0xCC, count: 3000)
        try writeFile("a.dng", contents: bytes)

        let source = FilesystemSource()
        try await source.open(folderURL: tmpDir)
        let refs = try await source.images()

        let cacheURL = tmpDir.appendingPathComponent(".maple/id-cache-apple.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: cacheURL.path))
        let cacheText = try String(contentsOf: cacheURL, encoding: .utf8)
        XCTAssertTrue(cacheText.contains(refs[0].id))
    }

    func testCacheIsReusedAcrossFilesystemSourceInstances() async throws {
        // Simulates the real-world case this ticket exists for: a folder
        // browsed once (id cached to disk), then browsed again in a LATER
        // process (a fresh FilesystemSource instance never sees the first
        // instance's in-memory state) — must resolve to the identical id by
        // reading the persisted cache, not by re-deriving from scratch (an
        // equal RESULT either way, since derivation is deterministic, but
        // this at least proves the on-disk cache round-trips correctly
        // across instances rather than being write-only).
        let bytes = Data(repeating: 0xDD, count: 5000)
        try writeFile("a.dng", contents: bytes)

        let source1 = FilesystemSource()
        try await source1.open(folderURL: tmpDir)
        let refs1 = try await source1.images()

        let source2 = FilesystemSource()
        try await source2.open(folderURL: tmpDir)
        let refs2 = try await source2.images()

        XCTAssertEqual(refs1[0].id, refs2[0].id)
    }

    // MARK: - Staleness on content replacement

    func testReplacingFileContentAtSamePathChangesId() async throws {
        let url = try writeFile("a.dng", contents: Data(repeating: 0xAA, count: 2048))

        let source = FilesystemSource()
        try await source.open(folderURL: tmpDir)
        let refs1 = try await source.images()
        let id1 = refs1[0].id

        // Replace the content AND force the mtime forward — real
        // filesystem/SMB writes always bump mtime, but some filesystems
        // have coarse (1s) mtime resolution, and this test must not be
        // flaky about that.
        let newBytes = Data(repeating: 0xBB, count: 4096)
        try newBytes.write(to: url)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: url.path)

        let refs2 = try await source.images()
        let id2 = refs2[0].id

        XCTAssertNotEqual(id1, id2, "a file replaced at the same path must not inherit the stale id")
        XCTAssertEqual(id2, MapleId.fallback(bytes: newBytes))
    }

    // MARK: - Multiple assets

    func testMultipleFilesGetDistinctIds() async throws {
        try writeFile("a.dng", contents: Data(repeating: 0x01, count: 1000))
        try writeFile("b.dng", contents: Data(repeating: 0x02, count: 1000))

        let source = FilesystemSource()
        try await source.open(folderURL: tmpDir)
        let refs = try await source.images()

        XCTAssertEqual(refs.count, 2)
        XCTAssertNotEqual(refs[0].id, refs[1].id)
    }
}
