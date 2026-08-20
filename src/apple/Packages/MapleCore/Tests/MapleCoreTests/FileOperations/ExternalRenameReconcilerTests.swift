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
    /// One shared store per test, mirroring `FilesystemSource`'s real usage
    /// (#2656 review — B4): production always passes the SAME
    /// `LibraryIndexStore` instance across every `reconcile` call for a
    /// folder's lifetime, so these tests do too rather than constructing a
    /// fresh instance per call.
    private var store: LibraryIndexStore!

    override func setUp() {
        super.setUp()
        root = FileOperationsTestSupport.makeTempDir()
        store = LibraryIndexStore(folderURL: root)
    }

    override func tearDown() {
        FileOperationsTestSupport.cleanup(root)
        root = nil
        store = nil
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
        // Size-gate (#2656 review — I7) rejects a new candidate whose REAL
        // on-disk `stat` size doesn't match a missing candidate's cached
        // size before even calling the fingerprint provider — so the
        // injected fingerprint's `size` must agree with what's actually
        // written to disk ("pixels" = 6 bytes), unlike the `dateTimeOriginal`
        // /`cameraSerial` fields, which the gate never inspects.
        let fingerprint = fp(6, "2026:01:01 10:00:00", "SN1")

        // Scan #1 (folder as Maple last saw it) — seeds the LibraryIndex's
        // cached fingerprint for IMG_1.dng.
        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [oldURL], fingerprintProvider: provider(["IMG_1.dng": fingerprint]))

        // Finder renames the file (and ONLY the file — the sidecar is left
        // behind under the old name, exactly like a real Finder rename).
        let newURL = root.appendingPathComponent("IMG_2.dng")
        try FileManager.default.moveItem(at: oldURL, to: newURL)

        // Scan #2 (either the next `open()`, or a live watcher callback).
        let applied = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [newURL], fingerprintProvider: provider(["IMG_2.dng": fingerprint]))

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
        // "pixels1"/"pixels2" are both 7 bytes — the size-gate (I7) must see
        // a real match before this test's ambiguity is even reachable.
        let shared = fp(7, "2026:02:02 00:00:00")
        FileOperationsTestSupport.write("pixels1", to: oneURL)
        FileOperationsTestSupport.write("pixels2", to: twoURL)
        FileOperationsTestSupport.write("<xmp edits='one'/>", to: SidecarPath.sidecarURL(for: oneURL))
        FileOperationsTestSupport.write("<xmp edits='two'/>", to: SidecarPath.sidecarURL(for: twoURL))

        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [oneURL, twoURL],
            fingerprintProvider: provider(["one.dng": shared, "two.dng": shared]))

        // Both vanish; only ONE new file carrying the shared fingerprint
        // appears — ambiguous which of the two it actually is.
        try FileManager.default.removeItem(at: oneURL)
        try FileManager.default.removeItem(at: twoURL)
        let renamedURL = root.appendingPathComponent("renamed.dng")
        FileOperationsTestSupport.write("pixels1", to: renamedURL)

        let applied = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [renamedURL],
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
        // Both files' real content is "pixels" (6 bytes) so the size-gate
        // (I7) — which checks the REAL on-disk size, not the fingerprint's
        // declared one — lets both through and this test actually exercises
        // the DateTimeOriginal mismatch it's named for.
        let sameSize: Int64 = 6

        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [beachURL],
            fingerprintProvider: provider(["beach.dng": fp(sameSize, "2026:03:01 09:00:00")]))

        try FileManager.default.moveItem(at: beachURL, to: root.appendingPathComponent("gone.dng"))
        // A genuinely different photo (different capture time) lands with
        // the coincidentally-same file size — this must NEVER attach
        // beach.dng's edits to it.
        let mountainURL = root.appendingPathComponent("mountain.dng")
        FileOperationsTestSupport.write("pixels", to: mountainURL)

        let applied = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [mountainURL],
            fingerprintProvider: provider(["mountain.dng": fp(sameSize, "2026:03:20 18:00:00")]))

        XCTAssertTrue(applied.isEmpty)
        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: mountainURL)),
                       "mountain.dng must not inherit beach.dng's edits")
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: beachURL)),
                      "beach.dng's sidecar stays orphaned rather than being wrongly attached")
    }

    // MARK: - Size-gate (#2656 review — I7): skip the EXIF read entirely
    // for a new file whose real on-disk size can't possibly match

    /// Lock-protected counter — a plain captured `var` can't satisfy
    /// `@Sendable` closure requirements. Mirrors `FolderChangeWatcherTests
    /// .FireCounter`.
    private final class CallCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func increment() { lock.lock(); count += 1; lock.unlock() }
        var current: Int { lock.lock(); defer { lock.unlock() }; return count }
    }

    func testSizeGateNeverInvokesTheFingerprintProviderForANonMatchingSize() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        FileOperationsTestSupport.write(String(repeating: "a", count: 100), to: oldURL)
        FileOperationsTestSupport.write("<xmp edits='real'/>", to: SidecarPath.sidecarURL(for: oldURL))
        let missingFingerprint = fp(100, "2026:06:01 00:00:00")

        // Seed the LibraryIndex with IMG_1.dng's fingerprint directly
        // (rather than through a full `reconcile` call) — isolates this
        // test from `syncFingerprintCache`'s own, independent provider
        // calls, which `reconcile(...)` also makes and which would
        // otherwise conflate two different reasons the provider might
        // legitimately be invoked.
        try await store.updateFingerprints([
            LibraryIndexStore.FingerprintUpdate(
                name: "IMG_1.dng", size: 100, mtime: nil,
                dateTimeOriginal: "2026:06:01 00:00:00", cameraSerial: nil),
        ])

        try FileManager.default.removeItem(at: oldURL)
        let newURL = root.appendingPathComponent("IMG_2.dng")
        // Deliberately NOT 100 bytes — the size-gate must reject this
        // candidate from a cheap `stat` alone, before ever asking the
        // (expensive, EXIF-reading) provider for a fingerprint.
        FileOperationsTestSupport.write("pixels", to: newURL)

        let counter = CallCounter()
        let previousEntries = try await store.load()?.entries ?? [:]
        let applied = await ExternalRenameReconciler.applyReconciliation(
            store: store, folderURL: root, currentFiles: [newURL],
            previousEntries: previousEntries,
            fingerprintProvider: { url in
                counter.increment()
                // Even a provider that WOULD produce a matching fingerprint
                // must never be consulted — the gate rejects on size first.
                return missingFingerprint
            })

        XCTAssertTrue(applied.isEmpty)
        XCTAssertEqual(counter.current, 0, "the fingerprint provider must never be called for a size that can't match")
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oldURL)))
    }

    // MARK: - No spurious reconciliation

    func testNoMissingFilesMeansNoReconciliationEvenWithNewFiles() async throws {
        let existingURL = root.appendingPathComponent("existing.dng")
        FileOperationsTestSupport.write("pixels", to: existingURL)
        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [existingURL],
            fingerprintProvider: provider(["existing.dng": fp(10, "2026:04:01 00:00:00")]))

        let addedURL = root.appendingPathComponent("added.dng")
        FileOperationsTestSupport.write("pixels", to: addedURL)

        let applied = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [existingURL, addedURL],
            fingerprintProvider: provider([
                "existing.dng": fp(10, "2026:04:01 00:00:00"),
                "added.dng": fp(10, "2026:04:01 00:00:00"),
            ]))

        XCTAssertTrue(applied.isEmpty, "a plain new import with nothing missing is not a rename")
    }

    // MARK: - Batched fingerprint cache writes (#2656 review — B1)

    /// One `reconcile` call warming several files' fingerprints for the
    /// first time must still leave every one of them correctly recorded —
    /// `syncFingerprintCache` batches every change into a single `store.
    /// updateFingerprints(_:)` call rather than one `save()` per file, and
    /// this is the correctness half of that (the perf half — exactly one
    /// atomic write no matter how many files — is a property of
    /// `updateFingerprints`'s implementation, covered by inspection: it
    /// calls `save()` exactly once, after its loop).
    func testOneReconcileCallWarmsFingerprintsForEveryFileInOneBatch() async throws {
        let names = ["a.dng", "b.dng", "c.dng"]
        let urls = names.map { root.appendingPathComponent($0) }
        for url in urls {
            FileOperationsTestSupport.write("pixels", to: url)
        }
        let table = Dictionary(uniqueKeysWithValues: names.map { ($0, fp(6, "2026:07:01 00:00:00")) })

        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: urls, fingerprintProvider: provider(table))

        let freshStore = LibraryIndexStore(folderURL: root)
        let index = try await freshStore.load()
        for name in names {
            let entry = try XCTUnwrap(index?.entries[name], "\(name) must have been warmed by the single batch call")
            XCTAssertEqual(entry.dateTimeOriginal, "2026:07:01 00:00:00")
        }
    }

    // MARK: - EXIF-less files (#2656 review, jules follow-up)

    /// A file the provider returns `nil` for (a PNG screenshot, a video, a
    /// corrupt RAW) must still count against `syncFingerprintCache`'s
    /// per-scan cap — otherwise a folder of thousands of EXIF-less files
    /// bypasses the cap entirely and reads every one of them in a single
    /// burst. The cap itself (`maxFingerprintWarmupPerScan`) is private, so
    /// this drives it indirectly: write more files than any reasonable cap
    /// (300) and confirm ONE scan does not warm all of them.
    func testExifLessFilesCountAgainstTheWarmupCap() async throws {
        let count = 300
        let urls = (0..<count).map { root.appendingPathComponent("shot-\($0).png") }
        for url in urls {
            FileOperationsTestSupport.write("pixels", to: url)
        }
        // Every file is "EXIF-less" — the provider always returns nil.
        let alwaysNil: @Sendable (URL) -> ExternalRenameFingerprint? = { _ in nil }

        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: urls, fingerprintProvider: alwaysNil)

        let firstScanIndex = try await LibraryIndexStore(folderURL: root).load()
        let attemptedAfterFirstScan = firstScanIndex?.entries.values.filter { $0.fingerprintAttempted == true }.count ?? 0
        XCTAssertGreaterThan(attemptedAfterFirstScan, 0)
        XCTAssertLessThan(
            attemptedAfterFirstScan, count,
            "a single scan must not warm every EXIF-less file when there are more than the per-scan cap")

        // A second scan (unchanged files) must make progress on the REST —
        // proves the cap makes warm-up incremental rather than permanently
        // stuck below full coverage.
        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: urls, fingerprintProvider: alwaysNil)
        let secondScanIndex = try await LibraryIndexStore(folderURL: root).load()
        let attemptedAfterSecondScan = secondScanIndex?.entries.values.filter { $0.fingerprintAttempted == true }.count ?? 0
        XCTAssertGreaterThan(attemptedAfterSecondScan, attemptedAfterFirstScan)
    }

    /// Once an EXIF-less file has been recorded (`fingerprintAttempted ==
    /// true` at its current size/mtime), a LATER scan over the same,
    /// unchanged folder must not re-invoke the provider for it at all —
    /// otherwise every single scan (every watcher tick) pays a full
    /// `ImageIO` read for that file for as long as it sits in the folder.
    func testUnchangedExifLessFolderTriggersNoProviderCallsOnASecondScan() async throws {
        let names = ["clip.mov", "screenshot.png", "corrupt.dng"]
        let urls = names.map { root.appendingPathComponent($0) }
        for url in urls {
            FileOperationsTestSupport.write("pixels", to: url)
        }

        let counter = CallCounter()
        let countingNilProvider: @Sendable (URL) -> ExternalRenameFingerprint? = { _ in
            counter.increment()
            return nil
        }

        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: urls, fingerprintProvider: countingNilProvider)
        XCTAssertEqual(counter.current, names.count, "sanity: the first scan must have attempted every file")

        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: urls, fingerprintProvider: countingNilProvider)

        XCTAssertEqual(
            counter.current, names.count,
            "an unchanged, already-attempted EXIF-less file must not be re-read on a later scan")
    }

    // MARK: - Fractional-second mtime (#2844 review): truncation, not rounding

    /// `index.json`'s ISO8601 mtime TRUNCATES the fractional part on write
    /// (it does not round it), so a file with a real mtime of X.7s is
    /// stored as X.0s. `.rounded()` on each side independently gets this
    /// wrong: stored X.0s rounds to X, but a fresh stat of the SAME,
    /// UNTOUCHED file (X.7s) rounds to X+1 — a guaranteed mismatch for any
    /// fractional part ≥ .5s, defeating the freshness check for roughly
    /// half of all real files. Pins a file's mtime to a fractional value
    /// ≥ .5s explicitly (rather than relying on incidental write timing) so
    /// this reproduces deterministically.
    func testAFractionalMtimeAtOrAboveHalfASecondIsStillTreatedAsUnchanged() async throws {
        let url = root.appendingPathComponent("IMG_1.dng")
        FileOperationsTestSupport.write("pixels", to: url)

        // Pin the mtime to a whole second plus .75s — comfortably ≥ .5s, the
        // exact case that regresses under `.rounded()`.
        let pinnedMtime = Date(timeIntervalSince1970: Date().timeIntervalSince1970.rounded(.down) + 0.75)
        try FileManager.default.setAttributes([.modificationDate: pinnedMtime], ofItemAtPath: url.path)

        let counter = CallCounter()
        let countingNilProvider: @Sendable (URL) -> ExternalRenameFingerprint? = { _ in
            counter.increment()
            return nil
        }

        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [url], fingerprintProvider: countingNilProvider)
        XCTAssertEqual(counter.current, 1, "sanity: the first scan must have attempted the file")

        // A second scan of the SAME, untouched file (mtime still pinned at
        // X.75s) must recognize it as unchanged and skip the provider —
        // this is the assertion that fails under `.rounded()`.
        _ = await ExternalRenameReconciler.reconcile(
            store: store, folderURL: root, currentFiles: [url], fingerprintProvider: countingNilProvider)

        XCTAssertEqual(
            counter.current, 1,
            "a file with a fractional mtime \u{2265} .5s must still be recognized as unchanged on a later scan")
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
            store: store, folderURL: root, currentFiles: [newURL],
            fingerprintProvider: provider(["IMG_2.dng": fp(1, "2026:05:01 00:00:00")]))

        XCTAssertTrue(applied.isEmpty)
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oldURL)))
    }
}
