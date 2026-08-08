// BatchRenameViewModelTests.swift — Filesystem-routed coverage for the
// Batch Rename sheet's view model (#2641). Real temp directories and real
// files — no mocks, per CLAUDE.md's file-operations testing convention.
//
// Focus: the design doc's explicit batch requirement — "applied
// SEQUENTIALLY... a template can collide with itself mid-batch, not only
// with pre-existing files" — plus partial-failure reporting and the
// preview/apply agreement the ticket's acceptance criteria calls out
// ("preview matches applied result").

import XCTest
@testable import MapleCore

@MainActor
final class BatchRenameViewModelTests: XCTestCase {
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

    private func makeAsset(_ name: String) -> AssetRef {
        let url = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent(name))
        return AssetRef(url: url)
    }

    // MARK: - Preview

    func testPreviewFlagsSelfCollisionWithinOneBatch() async throws {
        // A fixed literal template collides every item onto the same name —
        // exactly the "not just a pre-existing file" case the design doc
        // calls out.
        let assets = [makeAsset("a.dng"), makeAsset("b.dng"), makeAsset("c.dng")]
        let vm = BatchRenameViewModel(assets: assets, routing: .filesystem)
        vm.template = "vacation.{ext}"

        await vm.refreshPreview()

        XCTAssertEqual(vm.preview.map(\.newFilename), ["vacation.dng", "vacation.dng", "vacation.dng"])
        XCTAssertEqual(vm.preview.map(\.duplicate), [false, true, true])
    }

    func testPreviewSequenceNumberIsPerAssetPosition() async throws {
        let assets = [makeAsset("a.dng"), makeAsset("b.dng"), makeAsset("c.dng")]
        let vm = BatchRenameViewModel(assets: assets, routing: .filesystem)
        vm.template = "IMG_{n}.{ext}"
        vm.sequenceStart = 1
        vm.sequencePadWidth = 3

        await vm.refreshPreview()

        XCTAssertEqual(vm.preview.map(\.newFilename), ["IMG_001.dng", "IMG_002.dng", "IMG_003.dng"])
    }

    // MARK: - Apply: sequential self-collision resolution

    func testApplyAutoSuffixesASelfCollidingTemplateSequentially() async throws {
        // Same colliding template as the preview test, but this asserts the
        // REAL on-disk outcome: each subsequent item must see the PREVIOUS
        // item's already-applied result and auto-suffix against it, not
        // just against files that existed before the batch started.
        let assets = [makeAsset("a.dng"), makeAsset("b.dng"), makeAsset("c.dng")]
        let vm = BatchRenameViewModel(assets: assets, routing: .filesystem)
        vm.template = "vacation.{ext}"
        vm.collision = .autoSuffix

        await vm.apply()

        let results = try XCTUnwrap(vm.applyResults)
        XCTAssertEqual(results.count, 3)
        let newNames: [String] = try results.map {
            guard case .renamed(let newFilename) = $0.outcome else {
                XCTFail("expected .renamed, got \($0.outcome)")
                return ""
            }
            return newFilename
        }
        // Every rendered name is unique on disk — auto-suffix took effect
        // for the second and third items against the first's real file.
        XCTAssertEqual(Set(newNames).count, 3)
        XCTAssertTrue(newNames.contains("vacation.dng"))
        for name in newNames {
            XCTAssertTrue(
                FileOperationsTestSupport.exists(root.appendingPathComponent(name)),
                "expected \(name) to exist on disk")
        }
        // Original names are gone (mode: .move).
        XCTAssertFalse(FileOperationsTestSupport.exists(root.appendingPathComponent("a.dng")))
        XCTAssertFalse(FileOperationsTestSupport.exists(root.appendingPathComponent("b.dng")))
        XCTAssertFalse(FileOperationsTestSupport.exists(root.appendingPathComponent("c.dng")))
    }

    func testApplySkipPolicyReportsSkippedNotFailed() async throws {
        let assets = [makeAsset("a.dng"), makeAsset("b.dng")]
        let vm = BatchRenameViewModel(assets: assets, routing: .filesystem)
        vm.template = "vacation.{ext}"
        vm.collision = .skip

        await vm.apply()

        let results = try XCTUnwrap(vm.applyResults)
        XCTAssertEqual(results.count, 2)
        guard case .renamed = results[0].outcome else {
            return XCTFail("expected first item renamed, got \(results[0].outcome)")
        }
        guard case .skipped = results[1].outcome else {
            return XCTFail("expected second item skipped, got \(results[1].outcome)")
        }
        // The skipped file's original name must still be on disk untouched.
        XCTAssertTrue(FileOperationsTestSupport.exists(root.appendingPathComponent("b.dng")))
    }

    // MARK: - Preview/apply agreement (acceptance criterion)

    func testPreviewMatchesAppliedResultForANonCollidingTemplate() async throws {
        let assets = [makeAsset("a.dng"), makeAsset("b.dng")]
        let vm = BatchRenameViewModel(assets: assets, routing: .filesystem)
        vm.template = "{original}_renamed.{ext}"

        await vm.refreshPreview()
        let previewNames = vm.preview.map(\.newFilename)

        await vm.apply()
        let results = try XCTUnwrap(vm.applyResults)
        let appliedNames: [String?] = results.map {
            guard case .renamed(let newFilename) = $0.outcome else { return nil }
            return newFilename
        }

        XCTAssertEqual(previewNames, appliedNames)
    }

    // MARK: - Unsupported routing

    func testUnsupportedRoutingReportsReasonForEveryItemWithoutTouchingDisk() async throws {
        let assets = [makeAsset("a.dng"), makeAsset("b.dng")]
        let vm = BatchRenameViewModel(
            assets: assets, routing: .unsupported("PhotoKit photos have no file on disk Maple can rename."))

        await vm.apply()

        let results = try XCTUnwrap(vm.applyResults)
        for result in results {
            guard case .failed(let message) = result.outcome else {
                return XCTFail("expected .failed, got \(result.outcome)")
            }
            XCTAssertTrue(message.contains("PhotoKit"))
        }
        XCTAssertTrue(FileOperationsTestSupport.exists(root.appendingPathComponent("a.dng")))
        XCTAssertTrue(FileOperationsTestSupport.exists(root.appendingPathComponent("b.dng")))
    }

    func testCanApplyIsFalseForUnsupportedRouting() {
        let assets = [makeAsset("a.dng")]
        let vm = BatchRenameViewModel(assets: assets, routing: .unsupported("no"))
        XCTAssertFalse(vm.canApply)
    }

    // MARK: - Regression: concurrent apply() (jules review, PR #2716)

    /// Without the fix, `apply()` set `isApplying` only AFTER awaiting
    /// `refreshPreview()`, leaving a window where the sheet's Apply button
    /// stayed enabled and a second tap could start a second sequential
    /// rename pass over the SAME files while the first was still running —
    /// two interleaved relocate passes on one file set, a genuine data
    /// hazard. `isApplying` must now flip to `true` synchronously, before
    /// any `await`, so a concurrent call sees the guard and is refused.
    func testConcurrentApplyIsRefused() async throws {
        let assets = (0..<5).map { makeAsset("img_\($0).dng") }
        let vm = BatchRenameViewModel(assets: assets, routing: .filesystem)
        vm.template = "{original}_renamed.{ext}"

        let firstTask = Task { @MainActor in await vm.apply() }
        // Let the first call run past its synchronous `isApplying = true`
        // and into its real suspension point (`await LocalFileOperations
        // .relocate` inside `applyFilesystem`'s per-asset loop).
        await Task.yield()
        await Task.yield()
        XCTAssertTrue(vm.isApplying, "expected the first apply() call to still be in flight")

        // A second apply() while the first is in flight must be refused
        // (return immediately, touching nothing) rather than starting a
        // second sequential pass that races the first over the same files.
        await vm.apply()

        await firstTask.value

        let results = try XCTUnwrap(vm.applyResults)
        XCTAssertEqual(results.count, assets.count)
        for result in results {
            guard case .renamed = result.outcome else {
                return XCTFail(
                    "expected every asset renamed cleanly with no cross-call race, got \(result.outcome)")
            }
        }
        // Every original name is gone exactly once — proof the refused
        // second call never touched the filesystem itself.
        for (index, _) in assets.enumerated() {
            XCTAssertFalse(
                FileOperationsTestSupport.exists(root.appendingPathComponent("img_\(index).dng")))
        }
    }

    // MARK: - Regression: duplicate ids in a server response (jules review)

    /// `Dictionary(uniqueKeysWithValues:)` traps on a duplicate key —
    /// reachable from a duplicated selection or a malformed API response.
    /// `indexByIDTolerantOfDuplicates` must index the SAME shape without
    /// crashing, keeping the first entry for a repeated id.
    func testIndexByIDTolerantOfDuplicatesKeepsFirstEntryAndDoesNotCrash() {
        struct Item { let id: String; let value: Int }
        let items = [
            Item(id: "a", value: 1),
            Item(id: "a", value: 2),
            Item(id: "b", value: 3),
        ]
        let byID = indexByIDTolerantOfDuplicates(items, id: \.id)
        XCTAssertEqual(byID.count, 2)
        XCTAssertEqual(byID["a"]?.value, 1)
        XCTAssertEqual(byID["b"]?.value, 3)
    }

    func testIndexByIDTolerantOfDuplicatesOnEmptyInput() {
        struct Item { let id: String }
        let byID = indexByIDTolerantOfDuplicates([Item](), id: \.id)
        XCTAssertTrue(byID.isEmpty)
    }

    // MARK: - Regression: negative sequence values (jules review)

    /// A negative `sequenceStart`/`sequencePadWidth` reaching
    /// `FilenameTemplateEngine.render`'s `UInt64`/`UInt` conversion used to
    /// trap unconditionally. The view model must never crash when these
    /// values go negative, whatever the source (the sheet's own fields now
    /// clamp at entry, but this proves the view model itself is safe
    /// independent of that UI-layer guard).
    func testNegativeSequenceValuesDoNotTrapDuringPreview() async throws {
        let assets = [makeAsset("a.dng")]
        let vm = BatchRenameViewModel(assets: assets, routing: .filesystem)
        vm.template = "{n}_{original}.{ext}"
        vm.sequenceStart = -5
        vm.sequencePadWidth = -3

        await vm.refreshPreview()

        XCTAssertEqual(vm.preview.first?.newFilename, "0_a.dng")
        XCTAssertNil(vm.preview.first?.error)
    }

    // MARK: - Regression: EXIF reads off-main and only-when-needed (jules re-review)

    /// `renderLocalPreview` used to call `ImageMetadataReader
    /// .readRawCaptureDateStrings` synchronously, on the main actor, for
    /// EVERY asset on EVERY debounced keystroke — a blocking disk read
    /// across the whole selection, even when the template had no
    /// `{date:...}` token to justify it. A template with no date token must
    /// perform ZERO reads.
    func testTemplateWithoutDateTokenPerformsZeroExifReads() async throws {
        let assets = [makeAsset("a.dng"), makeAsset("b.dng"), makeAsset("c.dng")]
        let vm = BatchRenameViewModel(assets: assets, routing: .filesystem)
        let counter = CallCounter()
        vm.captureDateReader = { _ in
            counter.increment()
            return "2024:01:01 00:00:00"
        }
        vm.template = "{original}_renamed.{ext}"

        await vm.refreshPreview()
        // A second refresh (template still date-free) must stay at zero too.
        vm.sequenceStart = 2
        await vm.refreshPreview()

        XCTAssertEqual(counter.count, 0)
        XCTAssertEqual(vm.preview.map(\.newFilename), ["a_renamed.dng", "b_renamed.dng", "c_renamed.dng"])
    }

    /// When the template DOES use `{date:...}`, the cache is populated
    /// exactly once — off the main actor — and reused across every later
    /// `refreshPreview()`, never re-read per keystroke.
    func testDateTokenPopulatesCaptureDateCacheOnceAcrossRepeatedRefreshes() async throws {
        let assets = [makeAsset("a.dng"), makeAsset("b.dng"), makeAsset("c.dng")]
        let vm = BatchRenameViewModel(assets: assets, routing: .filesystem)
        let counter = CallCounter()
        vm.captureDateReader = { _ in
            counter.increment()
            return "2024:01:01 00:00:00"
        }
        vm.template = "{date:%Y}_{original}.{ext}"

        await vm.refreshPreview()
        XCTAssertEqual(counter.count, assets.count, "expected exactly one read per asset on first resolve")
        XCTAssertEqual(vm.preview.map(\.newFilename), ["2024_a.dng", "2024_b.dng", "2024_c.dng"])

        // Repeated refreshes — including a template edit that still uses a
        // date token — must reuse the cache, not re-read.
        vm.sequenceStart = 7
        await vm.refreshPreview()
        vm.template = "{date:%Y}-{n}_{original}.{ext}"
        await vm.refreshPreview()

        XCTAssertEqual(
            counter.count, assets.count,
            "expected the reader to run exactly once per asset total, not once per refresh")
    }
}

// MARK: - CallCounter

/// Thread-safe call counter for `captureDateReader` injection —
/// `ensureCapturedAtCacheIfNeeded` runs the reader concurrently inside a
/// `TaskGroup`, off the main actor, so a plain `var` would race.
private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return _count
    }

    func increment() {
        lock.lock()
        _count += 1
        lock.unlock()
    }
}
