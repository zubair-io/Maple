// FilesystemSourceCaptureDateTests.swift — #2274 (unified Timeline Phase 2).
//
// `FilesystemSource.images()` now populates `ImageRef.captureDate` from
// `LibraryIndex.LibraryEntry.dateTimeOriginal` — the same EXIF cache
// `ExternalRenameReconciler.syncFingerprintCache` already warms for
// same-folder external-rename detection (#2656). These tests stub the
// fingerprint provider (same seam `FilesystemSourceExternalRenameTests`
// uses) rather than requiring a real EXIF-bearing RAW fixture, since the
// behavior under test is the captureDate WIRING, not EXIF extraction
// itself (that's `ImageMetadataReader`'s own coverage).

import XCTest
@testable import MapleCore

final class FilesystemSourceCaptureDateTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("filesystem-source-capture-date-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    /// The exact UTC `Date` "2026:01:01 12:34:56" (EXIF wall-clock, no
    /// timezone designator — see `ExifCaptureDate`'s doc comment) resolves
    /// to under the UTC assumption `iso8601UTC` documents.
    private var expectedDate: Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        var comps = DateComponents()
        comps.year = 2026; comps.month = 1; comps.day = 1
        comps.hour = 12; comps.minute = 34; comps.second = 56
        return cal.date(from: comps)!
    }

    func testImagesPopulatesCaptureDateFromTheCachedFingerprint() async throws {
        let url = tmpDir.appendingPathComponent("IMG_1.dng")
        try Data("pixels".utf8).write(to: url)

        let provider: @Sendable (URL) -> ExternalRenameFingerprint? = { fileURL in
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
                  let size = (attrs[.size] as? NSNumber)?.int64Value
            else { return nil }
            return ExternalRenameFingerprint(size: size, dateTimeOriginal: "2026:01:01 12:34:56")
        }

        let source = FilesystemSource()
        await source.setExternalRenameFingerprintProvider(provider)
        try await source.open(folderURL: tmpDir)

        let refs = try await source.images()

        XCTAssertEqual(refs.count, 1)
        XCTAssertEqual(refs[0].captureDate, expectedDate)
    }

    /// A file the fingerprint provider finds no EXIF for (PNG screenshot,
    /// corrupt RAW, etc.) — `captureDate` stays `nil` rather than defaulting
    /// to some placeholder; callers (`FolderMergeAdapter`) decide their own
    /// fallback for "unknown date," which isn't this layer's job.
    func testImagesLeavesCaptureDateNilWhenNoFingerprintIsAvailable() async throws {
        let url = tmpDir.appendingPathComponent("IMG_2.dng")
        try Data("pixels".utf8).write(to: url)

        let noExifProvider: @Sendable (URL) -> ExternalRenameFingerprint? = { _ in nil }

        let source = FilesystemSource()
        await source.setExternalRenameFingerprintProvider(noExifProvider)
        try await source.open(folderURL: tmpDir)

        let refs = try await source.images()

        XCTAssertEqual(refs.count, 1)
        XCTAssertNil(refs[0].captureDate)
    }

    /// The point of caching in `LibraryIndex` (#2274's other half): a
    /// SECOND, freshly-constructed `FilesystemSource` opening the SAME
    /// folder must see the capture date WITHOUT its own fingerprint
    /// provider ever being asked — proves the value came from
    /// `.maple/index.json`, not a fresh EXIF read.
    func testCaptureDateSurvivesAFreshFilesystemSourceReopeningTheSameFolder() async throws {
        let url = tmpDir.appendingPathComponent("IMG_3.dng")
        try Data("pixels".utf8).write(to: url)

        let warmingProvider: @Sendable (URL) -> ExternalRenameFingerprint? = { fileURL in
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
                  let size = (attrs[.size] as? NSNumber)?.int64Value
            else { return nil }
            return ExternalRenameFingerprint(size: size, dateTimeOriginal: "2026:01:01 12:34:56")
        }
        let first = FilesystemSource()
        await first.setExternalRenameFingerprintProvider(warmingProvider)
        try await first.open(folderURL: tmpDir)
        _ = try await first.images()
        await first.close()

        final class CallRecorder: @unchecked Sendable {
            private let lock = NSLock()
            private(set) var callCount = 0
            func record() { lock.lock(); callCount += 1; lock.unlock() }
        }
        let recorder = CallRecorder()
        let mustNotBeCalledProvider: @Sendable (URL) -> ExternalRenameFingerprint? = { _ in
            recorder.record()
            return nil
        }

        let second = FilesystemSource()
        await second.setExternalRenameFingerprintProvider(mustNotBeCalledProvider)
        try await second.open(folderURL: tmpDir)

        let refs = try await second.images()

        XCTAssertEqual(refs.count, 1)
        XCTAssertEqual(refs[0].captureDate, expectedDate,
                       "captureDate must come from the on-disk LibraryIndex cache")
        // The size/mtime-unchanged skip in `syncFingerprintCache` means the
        // second open's own provider is never consulted for this file.
        XCTAssertEqual(recorder.callCount, 0,
                       "a fresh source reopening an unchanged file must not re-read its EXIF")
    }
}
