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
}
