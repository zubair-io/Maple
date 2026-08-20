// LibraryIndexStoreSingleWriterTests.swift — issue #2844: two independent
// `LibraryIndexStore` instances over the SAME `index.json` used to be two
// drifting in-memory copies (each cached its first `load()` forever), so
// the last one to `save()` silently discarded whatever the other had
// written. `LibraryIndexStore` now re-reads `index.json` fresh on every
// call instead of trusting a cached snapshot — these tests prove the actual
// interleaving that broke, not just the read/write primitives in isolation.
// Real temp directories and real JSON round-trips throughout — no mocks.

import XCTest
@testable import MapleCore

final class LibraryIndexStoreSingleWriterTests: XCTestCase {
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

    // MARK: - (1) Two independent stores, interleaved writes both survive

    /// Two SEPARATE `LibraryIndexStore` instances over the same folder —
    /// exactly the shape `LocalFileOperations+CacheAndIndex.swift`'s
    /// `refreshLibraryIndexAfterMove` produces whenever a caller doesn't
    /// pass `externalStore:`. Store A loads (caching, in the old code, an
    /// empty/one-entry snapshot), then store B writes a DIFFERENT entry,
    /// then store A writes again. Before the fix, A's second write was a
    /// blind overwrite from its stale cache and silently dropped B's entry.
    func testTwoIndependentStoresOverTheSameFolderBothSurvive() async throws {
        let storeA = LibraryIndexStore(folderURL: root)
        let storeB = LibraryIndexStore(folderURL: root)

        // A establishes the file and caches (in the pre-fix code) its own
        // view of it.
        try await storeA.updateEntry(name: "IMG_1.dng", culling: CullingState(stars: 1, flag: .none))
        _ = try await storeA.load()

        // B, a totally independent instance, adds its own entry.
        try await storeB.updateEntry(name: "IMG_2.dng", culling: CullingState(stars: 5, flag: .pick))

        // A writes again — a real caller updating IMG_1's stars, say.
        try await storeA.updateEntry(name: "IMG_1.dng", culling: CullingState(stars: 2, flag: .none))

        // A fresh THIRD store proves what's actually on disk, not what
        // either A or B believes.
        let verifyStore = LibraryIndexStore(folderURL: root)
        let index = try await verifyStore.load()

        let entry1 = try XCTUnwrap(index?.entries["IMG_1.dng"])
        XCTAssertEqual(entry1.stars, 2, "A's second write must be reflected")
        let entry2 = try XCTUnwrap(index?.entries["IMG_2.dng"], "B's write must survive A's later save")
        XCTAssertEqual(entry2.stars, 5)
        XCTAssertEqual(entry2.flag, "pick")
    }

    /// Same shape, but the interleaved write is a REMOVAL — mirrors
    /// `refreshLibraryIndexAfterMove` removing the OLD entry from a fresh
    /// store while the folder's persistent store still has a cached copy of
    /// it. The removal must not be resurrected by a later save from the
    /// stale-cache side.
    func testARemovalFromOneStoreIsNotResurrectedByAnothersLaterSave() async throws {
        let persistent = LibraryIndexStore(folderURL: root)
        try await persistent.updateEntry(name: "IMG_1.dng", culling: CullingState(stars: 3, flag: .pick))
        try await persistent.updateEntry(name: "IMG_2.dng", culling: CullingState(stars: 0, flag: .none))
        // Populate the persistent store's (pre-fix) in-memory cache with
        // BOTH entries before the independent store removes one of them.
        _ = try await persistent.load()

        let independent = LibraryIndexStore(folderURL: root)
        try await independent.removeEntry(named: "IMG_1.dng")

        // The persistent store now updates the OTHER entry — a fingerprint
        // refresh, say — which is exactly the write that used to
        // resurrect IMG_1.dng from stale cache.
        try await persistent.updateFingerprints([
            LibraryIndexStore.FingerprintUpdate(
                name: "IMG_2.dng", size: 42, mtime: nil, dateTimeOriginal: "2026:01:01 00:00:00", cameraSerial: nil),
        ])

        let verifyStore = LibraryIndexStore(folderURL: root)
        let index = try await verifyStore.load()
        XCTAssertNil(index?.entries["IMG_1.dng"], "the independent store's removal must not be resurrected")
        XCTAssertNotNil(index?.entries["IMG_2.dng"])
    }

    // MARK: - (2) Concrete reported scenario: in-app rename, then a reconcile pass

    /// The exact interleaving #2844 reports: an ordinary in-app rename in a
    /// watched, open folder (which relocates via a FRESH `LibraryIndexStore`
    /// — see `LocalFileOperations.relocate`) followed by the folder's own
    /// `FilesystemSource`-owned persistent store running a reconcile pass
    /// (what the debounced `FolderChangeWatcher` tick does via `_index()`).
    /// Before the fix, the persistent store's stale cached snapshot —
    /// populated by `open()`'s own first scan — silently overwrote the
    /// rename's already-committed `index.json` the moment the reconcile
    /// pass's `syncFingerprintCache` triggered its own save.
    func testInAppRenameFollowedByReconcilePassLeavesTheRenamedEntryCorrect() async throws {
        let oldURL = root.appendingPathComponent("IMG_1.dng")
        FileOperationsTestSupport.write("pixels", to: oldURL)
        FileOperationsTestSupport.write("<xmp edits='real'/>", to: SidecarPath.sidecarURL(for: oldURL))

        // Culling state recorded before the rename — must carry over to the
        // renamed entry, and must NOT be reverted to "never culled" by a
        // stale reconcile save.
        let seedStore = LibraryIndexStore(folderURL: root)
        try await seedStore.updateEntry(name: "IMG_1.dng", culling: CullingState(stars: 4, flag: .pick))

        let source = FilesystemSource()
        await source.setExternalRenameFingerprintProvider { url in
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
                  let size = (attrs[.size] as? NSNumber)?.int64Value
            else { return nil }
            return ExternalRenameFingerprint(size: size, dateTimeOriginal: "2026:01:01 00:00:00")
        }
        // `open()` runs its own first `_index()` scan — this is what
        // populates the persistent store's stale in-memory cache in the
        // pre-fix code, well before the in-app rename below ever happens.
        try await source.open(folderURL: root)

        // The in-app rename itself: same shape as `AppShell+AssetRename`'s
        // `renameLocalAsset`, which calls `LocalFileOperations.relocate`
        // with no `externalStore` — a FRESH `LibraryIndexStore`, entirely
        // independent of the one `source` is holding onto.
        let newURL = root.appendingPathComponent("IMG_2.dng")
        _ = try await LocalFileOperations.relocate(
            oldURL, to: root, newBasename: "IMG_2.dng", mode: .move, collision: .fail)

        // The debounced watcher tick firing after the rename — reconciles
        // against the CURRENT folder listing (already renamed) using the
        // source's own persistent (and, pre-fix, stale-cached) store.
        try await source._index()

        let verifyStore = LibraryIndexStore(folderURL: root)
        let index = try await verifyStore.load()

        XCTAssertNil(index?.entries["IMG_1.dng"], "the old filename's entry must not be resurrected by the reconcile pass")
        let renamedEntry = try XCTUnwrap(index?.entries["IMG_2.dng"], "the renamed entry must be present in index.json")
        XCTAssertEqual(renamedEntry.stars, 4, "culling state from before the rename must carry over")
        XCTAssertEqual(renamedEntry.flag, "pick")

        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: oldURL)))
        XCTAssertEqual(
            FileOperationsTestSupport.contents(SidecarPath.sidecarURL(for: newURL)),
            "<xmp edits='real'/>")

        let refs = try await source.images()
        XCTAssertEqual(refs.map(\.displayName), ["IMG_2"])
    }

    // MARK: - (3) A genuine read error must abort the write, not clobber it

    /// `updateEntry`/`updateFingerprints` used to fall back to `try? load()`
    /// — which silently turns ANY read failure into `nil`, indistinguishable
    /// from "no index on disk yet." A malformed `index.json` (truncated
    /// write, disk corruption, a future format neither of these methods
    /// understands) would then be treated as "start fresh," and the
    /// mutator's `save()` would overwrite it with a brand-new, empty index —
    /// permanently destroying every entry's stars/flags/fingerprints that
    /// were sitting in the unreadable file. A genuine read error must
    /// propagate and abort the write instead.
    func testUpdateEntryPropagatesAGenuineReadErrorInsteadOfClobberingTheFile() async throws {
        let mapleDir = root.appendingPathComponent(".maple")
        try FileManager.default.createDirectory(at: mapleDir, withIntermediateDirectories: true)
        let indexURL = mapleDir.appendingPathComponent("index.json")
        let malformed = "{ this is not valid JSON at all"
        try malformed.write(to: indexURL, atomically: true, encoding: .utf8)

        let store = LibraryIndexStore(folderURL: root)
        do {
            try await store.updateEntry(name: "IMG_1.dng", culling: CullingState(stars: 5, flag: .pick))
            XCTFail("a malformed index.json must throw, not be silently treated as missing")
        } catch {
            // Expected — the read error must propagate.
        }

        let onDisk = try String(contentsOf: indexURL, encoding: .utf8)
        XCTAssertEqual(onDisk, malformed, "a failed update must leave the on-disk file byte-for-byte unchanged")
    }

    /// Same guard, for the OTHER mutator that had the same `try?` pattern.
    func testUpdateFingerprintsPropagatesAGenuineReadErrorInsteadOfClobberingTheFile() async throws {
        let mapleDir = root.appendingPathComponent(".maple")
        try FileManager.default.createDirectory(at: mapleDir, withIntermediateDirectories: true)
        let indexURL = mapleDir.appendingPathComponent("index.json")
        let malformed = "{ this is not valid JSON at all"
        try malformed.write(to: indexURL, atomically: true, encoding: .utf8)

        let store = LibraryIndexStore(folderURL: root)
        do {
            try await store.updateFingerprints([
                LibraryIndexStore.FingerprintUpdate(
                    name: "IMG_1.dng", size: 6, mtime: nil, dateTimeOriginal: "2026:01:01 00:00:00", cameraSerial: nil),
            ])
            XCTFail("a malformed index.json must throw, not be silently treated as missing")
        } catch {
            // Expected — the read error must propagate.
        }

        let onDisk = try String(contentsOf: indexURL, encoding: .utf8)
        XCTAssertEqual(onDisk, malformed, "a failed update must leave the on-disk file byte-for-byte unchanged")
    }
}
