// FilesystemSourceExternalRenameTests.swift — issue #2656 acceptance
// coverage for BOTH paths the ticket calls out: a rename made while Maple
// is CLOSED (reconciled by the next `open()`'s rescan diff) and a rename
// made while Maple is OPEN (reconciled by the live folder watcher's
// debounced callback). Real temp directories, real `.xmp` sidecars — no
// mocks.
//
// The "Maple open" case drives `_index()` directly (module-internal, the
// exact function `FolderChangeWatcher`'s callback calls) rather than
// waiting on a real `DispatchSource` + debounce round trip — that
// mechanism is covered on its own, more cheaply and deterministically, by
// `FolderChangeWatcherTests`. What matters here is that the SAME
// reconciliation runs regardless of what triggered the re-scan.

import XCTest
@testable import MapleCore

final class FilesystemSourceExternalRenameTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("filesystem-source-external-rename-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    /// Fingerprint by file SIZE alone, tagged with a fixed capture
    /// timestamp — realistic in shape (production fingerprints content, not
    /// filename, and content survives a rename byte-for-byte) and safe here
    /// because each test below only ever has one real photo in flight, so
    /// there's no ambiguity to accidentally test around.
    private let stubProvider: @Sendable (URL) -> ExternalRenameFingerprint? = { url in
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (attrs[.size] as? NSNumber)?.int64Value
        else { return nil }
        return ExternalRenameFingerprint(size: size, dateTimeOriginal: "2026:01:01 00:00:00")
    }

    // MARK: - Maple CLOSED for the rename

    func testRenameWhileClosedIsReconciledOnNextOpen() async throws {
        let oldURL = tmpDir.appendingPathComponent("IMG_1.dng")
        try Data("pixels".utf8).write(to: oldURL)
        try "<xmp edits='real'/>".write(to: SidecarPath.sidecarURL(for: oldURL), atomically: true, encoding: .utf8)

        let source = FilesystemSource()
        await source.setExternalRenameFingerprintProvider(stubProvider)
        try await source.open(folderURL: tmpDir)
        await source.close()

        // Finder renames the file while Maple is closed — no watcher, no
        // running process to observe it.
        let newURL = tmpDir.appendingPathComponent("IMG_2.dng")
        try FileManager.default.moveItem(at: oldURL, to: newURL)

        let reopened = FilesystemSource()
        await reopened.setExternalRenameFingerprintProvider(stubProvider)
        try await reopened.open(folderURL: tmpDir)

        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oldURL)))
        XCTAssertEqual(
            FileOperationsTestSupport.contents(SidecarPath.sidecarURL(for: newURL)),
            "<xmp edits='real'/>",
            "the edits made before the external rename must still be found after reopening")

        let refs = try await reopened.images()
        XCTAssertEqual(refs.map(\.displayName), ["IMG_2"])
    }

    // MARK: - Maple OPEN for the rename

    func testRenameWhileOpenIsReconciledOnTheNextReindex() async throws {
        let oldURL = tmpDir.appendingPathComponent("IMG_1.dng")
        try Data("pixels".utf8).write(to: oldURL)
        try "<xmp edits='real'/>".write(to: SidecarPath.sidecarURL(for: oldURL), atomically: true, encoding: .utf8)

        let source = FilesystemSource()
        await source.setExternalRenameFingerprintProvider(stubProvider)
        try await source.open(folderURL: tmpDir)

        // Finder renames the file while Maple stays open — this is what a
        // `FolderChangeWatcher` debounced callback would observe.
        let newURL = tmpDir.appendingPathComponent("IMG_2.dng")
        try FileManager.default.moveItem(at: oldURL, to: newURL)
        try await source._index()

        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oldURL)))
        XCTAssertEqual(
            FileOperationsTestSupport.contents(SidecarPath.sidecarURL(for: newURL)),
            "<xmp edits='real'/>")

        let refs = try await source.images()
        XCTAssertEqual(refs.map(\.displayName), ["IMG_2"])
    }

    // MARK: - False positive guard, wired end to end

    func testTwoCandidatesWhileOpenDeclineAndKeepBothSidecarsOrphaned() async throws {
        let oneURL = tmpDir.appendingPathComponent("one.dng")
        let twoURL = tmpDir.appendingPathComponent("two.dng")
        // Identical size on both — same fingerprint, so a single new file
        // matching it is genuinely ambiguous between the two.
        try Data("XXXXX".utf8).write(to: oneURL)
        try Data("XXXXX".utf8).write(to: twoURL)
        try "<xmp edits='one'/>".write(to: SidecarPath.sidecarURL(for: oneURL), atomically: true, encoding: .utf8)
        try "<xmp edits='two'/>".write(to: SidecarPath.sidecarURL(for: twoURL), atomically: true, encoding: .utf8)

        let source = FilesystemSource()
        await source.setExternalRenameFingerprintProvider(stubProvider)
        try await source.open(folderURL: tmpDir)

        try FileManager.default.removeItem(at: oneURL)
        try FileManager.default.removeItem(at: twoURL)
        let renamedURL = tmpDir.appendingPathComponent("renamed.dng")
        try Data("XXXXX".utf8).write(to: renamedURL)
        try await source._index()

        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oneURL)),
                      "ambiguous match must decline — one.dng's sidecar stays orphaned")
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: twoURL)),
                      "ambiguous match must decline — two.dng's sidecar stays orphaned")
        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: renamedURL)),
                       "renamed.dng must not inherit either photo's edits")
    }
}
