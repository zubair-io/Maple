// ExternalRenameReconcilerTests.swift — issue #2656: the folder-level
// diff-and-apply orchestration, driven with an injected fingerprint
// provider (per the ticket's guidance — plain temp-dir fixtures carry no
// real EXIF, so `ExternalRenameFingerprint.live` can't be exercised here;
// `ExternalRenameFingerprint+Live.swift`'s doc comment covers why). Real
// `.xmp` files on real temp directories throughout — no mocks.

import XCTest
@testable import MapleCore

final class ExternalRenameReconcilerTests: XCTestCase {
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

    /// A deterministic fingerprint provider keyed off filename content the
    /// test controls — mirrors how a real caller would inject fixtures per
    /// CLAUDE.md's guidance for this exact case.
    private func provider(_ table: [String: ExternalRenameFingerprint]) -> @Sendable (URL) -> ExternalRenameFingerprint? {
        { url in table[url.lastPathComponent] }
    }

    private func fp(_ size: Int64, _ dto: String, _ serial: String? = nil) -> ExternalRenameFingerprint {
        ExternalRenameFingerprint(size: size, dateTimeOriginal: dto, cameraSerial: serial)
    }

    // MARK: - Happy path: reconciles across two scans (simulates a rescan diff)

    func testReconcilesARenameDetectedBetweenTwoScans() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        FileOperationsTestSupport.write("pixels", to: oldURL)
        FileOperationsTestSupport.write("<xmp edits='real'/>", to: SidecarPath.sidecarURL(for: oldURL))
        let fingerprint = fp(1000, "2026:01:01 10:00:00", "SN1")

        // Scan #1 (folder as Maple last saw it) — seeds the LibraryIndex's
        // cached fingerprint for IMG_1.dng.
        _ = await ExternalRenameReconciler.reconcile(
            folderURL: root, currentFiles: [oldURL], fingerprintProvider: provider(["IMG_1.dng": fingerprint]))

        // Finder renames the file (and ONLY the file — the sidecar is left
        // behind under the old name, exactly like a real Finder rename).
        let newURL = root.appendingPathComponent("IMG_2.dng")
        try FileManager.default.moveItem(at: oldURL, to: newURL)

        // Scan #2 (either the next `open()`, or a live watcher callback).
        let applied = await ExternalRenameReconciler.reconcile(
            folderURL: root, currentFiles: [newURL], fingerprintProvider: provider(["IMG_2.dng": fingerprint]))

        XCTAssertEqual(applied, [ExternalRenameMatcher.Match(oldPath: oldURL.path, newPath: newURL.path)])
        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oldURL)))
        XCTAssertEqual(
            FileOperationsTestSupport.contents(SidecarPath.sidecarURL(for: newURL)),
            "<xmp edits='real'/>")
    }

    // MARK: - MANDATORY false-positive guard: two candidates decline

    func testTwoMissingCandidatesSharingAFingerprintDeclineAndLeaveBothSidecarsOrphaned() async throws {
        let oneURL = root.appendingPathComponent("one.dng")
        let twoURL = root.appendingPathComponent("two.dng")
        let shared = fp(500, "2026:02:02 00:00:00")
        FileOperationsTestSupport.write("pixels1", to: oneURL)
        FileOperationsTestSupport.write("pixels2", to: twoURL)
        FileOperationsTestSupport.write("<xmp edits='one'/>", to: SidecarPath.sidecarURL(for: oneURL))
        FileOperationsTestSupport.write("<xmp edits='two'/>", to: SidecarPath.sidecarURL(for: twoURL))

        _ = await ExternalRenameReconciler.reconcile(
            folderURL: root, currentFiles: [oneURL, twoURL],
            fingerprintProvider: provider(["one.dng": shared, "two.dng": shared]))

        // Both vanish; only ONE new file carrying the shared fingerprint
        // appears — ambiguous which of the two it actually is.
        try FileManager.default.removeItem(at: oneURL)
        try FileManager.default.removeItem(at: twoURL)
        let renamedURL = root.appendingPathComponent("renamed.dng")
        FileOperationsTestSupport.write("pixels1", to: renamedURL)

        let applied = await ExternalRenameReconciler.reconcile(
            folderURL: root, currentFiles: [renamedURL],
            fingerprintProvider: provider(["renamed.dng": shared]))

        XCTAssertTrue(applied.isEmpty, "two missing candidates sharing a fingerprint must decline, not guess")
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oneURL)),
                      "declined reconciliation must leave both orphaned sidecars exactly where they were")
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: twoURL)))
    }

    func testTwoDifferentPhotosSharingOnlySizeNeverGetMergedEndToEnd() async throws {
        let beachURL = root.appendingPathComponent("beach.dng")
        FileOperationsTestSupport.write("pixels", to: beachURL)
        FileOperationsTestSupport.write("<xmp edits='beach'/>", to: SidecarPath.sidecarURL(for: beachURL))
        let sameSize: Int64 = 999_999

        _ = await ExternalRenameReconciler.reconcile(
            folderURL: root, currentFiles: [beachURL],
            fingerprintProvider: provider(["beach.dng": fp(sameSize, "2026:03:01 09:00:00")]))

        try FileManager.default.moveItem(at: beachURL, to: root.appendingPathComponent("gone.dng"))
        // A genuinely different photo (different capture time) lands with
        // the coincidentally-same file size — this must NEVER attach
        // beach.dng's edits to it.
        let mountainURL = root.appendingPathComponent("mountain.dng")
        FileOperationsTestSupport.write("pixels", to: mountainURL)

        let applied = await ExternalRenameReconciler.reconcile(
            folderURL: root, currentFiles: [mountainURL],
            fingerprintProvider: provider(["mountain.dng": fp(sameSize, "2026:03:20 18:00:00")]))

        XCTAssertTrue(applied.isEmpty)
        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: mountainURL)),
                       "mountain.dng must not inherit beach.dng's edits")
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: beachURL)),
                      "beach.dng's sidecar stays orphaned rather than being wrongly attached")
    }

    // MARK: - No spurious reconciliation

    func testNoMissingFilesMeansNoReconciliationEvenWithNewFiles() async throws {
        let existingURL = root.appendingPathComponent("existing.dng")
        FileOperationsTestSupport.write("pixels", to: existingURL)
        _ = await ExternalRenameReconciler.reconcile(
            folderURL: root, currentFiles: [existingURL],
            fingerprintProvider: provider(["existing.dng": fp(10, "2026:04:01 00:00:00")]))

        let addedURL = root.appendingPathComponent("added.dng")
        FileOperationsTestSupport.write("pixels", to: addedURL)

        let applied = await ExternalRenameReconciler.reconcile(
            folderURL: root, currentFiles: [existingURL, addedURL],
            fingerprintProvider: provider([
                "existing.dng": fp(10, "2026:04:01 00:00:00"),
                "added.dng": fp(10, "2026:04:01 00:00:00"),
            ]))

        XCTAssertTrue(applied.isEmpty, "a plain new import with nothing missing is not a rename")
    }

    func testAnUnfingerprintableMissingEntryIsExcludedFromMatching() async throws {
        // The old entry was NEVER successfully fingerprinted (e.g. its EXIF
        // couldn't be read on the scan that saw it) — `dateTimeOriginal` is
        // absent from the LibraryIndex entry. Falling back to matching on
        // size alone here is exactly the false-positive shape the mandatory
        // guard forbids, so this must decline.
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        FileOperationsTestSupport.write("pixels", to: oldURL)
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: oldURL))
        let store = LibraryIndexStore(folderURL: root)
        // Seed an entry with a size but no dateTimeOriginal/cameraSerial —
        // simulates a prior scan where EXIF extraction failed.
        try await store.updateEntry(name: "IMG_1.dng", culling: CullingState())

        try FileManager.default.moveItem(at: oldURL, to: root.appendingPathComponent("IMG_2.dng"))
        let newURL = root.appendingPathComponent("IMG_2.dng")

        let applied = await ExternalRenameReconciler.reconcile(
            folderURL: root, currentFiles: [newURL],
            fingerprintProvider: provider(["IMG_2.dng": fp(1, "2026:05:01 00:00:00")]))

        XCTAssertTrue(applied.isEmpty)
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oldURL)))
    }
}
