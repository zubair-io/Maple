#if os(iOS)
  import Foundation
  import MapleCore
  import XCTest

  @testable import Maple

  @MainActor
  final class BatchExportPanelVMTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
      directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("BatchExportPanelVMTests-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
      try? FileManager.default.removeItem(at: directory)
    }

    func testStagesAllPhotosWithChosenOptionsAndUniqueNames() async throws {
      let first = AssetRef.preview(displayName: "Same.dng")
      let second = AssetRef.preview(displayName: "Same.dng")
      let vm = BatchExportPanelVM(
        resolveSession: { EditSession(asset: $0) },
        exportData: { session, options in
          XCTAssertEqual(options.format, .png)
          XCTAssertEqual(options.sizeOption, .full)
          XCTAssertTrue(session.hasLoadedSidecar)
          return Data(session.asset.id.uuidString.utf8)
        })
      vm.format = .png
      vm.sizeOption = .full

      await vm.begin(assets: [first, second], in: directory).value

      let staged = try XCTUnwrap(vm.stagedBatch)
      XCTAssertEqual(staged.files.map(\.lastPathComponent), ["Same.dng.png", "Same.dng-2.png"])
      XCTAssertEqual(try Data(contentsOf: staged.files[0]), Data(first.id.uuidString.utf8))
      XCTAssertEqual(try Data(contentsOf: staged.files[1]), Data(second.id.uuidString.utf8))
      XCTAssertEqual(vm.completedCount, 2)
      XCTAssertNil(vm.exportError)
      vm.finishSharing(completed: false, error: nil)
      XCTAssertNil(vm.stagedBatch)
    }

    func testSecondPhotoFailureDoesNotPublishPartialBatch() async throws {
      struct Failure: LocalizedError {
        var errorDescription: String? { "second photo failed" }
      }
      let first = AssetRef.preview(displayName: "First.dng")
      let second = AssetRef.preview(displayName: "Second.dng")
      let vm = BatchExportPanelVM(
        resolveSession: { EditSession(asset: $0) },
        exportData: { session, _ in
          if session.asset.id == second.id { throw Failure() }
          return Data([1, 2, 3])
        })

      await vm.begin(assets: [first, second], in: directory).value

      XCTAssertNil(vm.stagedBatch)
      XCTAssertEqual(vm.exportError, "second photo failed")
      XCTAssertFalse(vm.isExporting)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testWrongSessionRejectsBatchWithoutWriting() async throws {
      let selected = AssetRef.preview(displayName: "Selected.dng")
      let vm = BatchExportPanelVM(
        resolveSession: { _ in EditSession.preview(displayName: "Other.dng") },
        exportData: { _, _ in
          XCTFail("Must not render wrong asset")
          return Data()
        })

      await vm.begin(assets: [selected], in: directory).value

      XCTAssertNil(vm.stagedBatch)
      XCTAssertNotNil(vm.exportError)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testCancelAfterFirstFileRemovesEntireBatch() async throws {
      let first = AssetRef.preview(displayName: "First.dng")
      let second = AssetRef.preview(displayName: "Second.dng")
      let secondStarted = expectation(description: "second render started")
      let vm = BatchExportPanelVM(
        resolveSession: { EditSession(asset: $0) },
        exportData: { session, _ in
          if session.asset.id == second.id {
            secondStarted.fulfill()
            try await Task.sleep(for: .seconds(10))
          }
          return Data([1, 2, 3])
        })
      let task = vm.begin(assets: [first, second], in: directory)
      await fulfillment(of: [secondStarted], timeout: 5)

      vm.cancelExport()
      await task.value

      XCTAssertNil(vm.stagedBatch)
      XCTAssertFalse(vm.isExporting)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testDuplicateSelectionIsRejected() async throws {
      let asset = AssetRef.preview(displayName: "Duplicate.dng")
      let vm = BatchExportPanelVM(
        resolveSession: { _ in
          XCTFail("Must not resolve duplicate selection")
          return EditSession.preview()
        })

      await vm.begin(assets: [asset, asset], in: directory).value

      XCTAssertNil(vm.stagedBatch)
      XCTAssertNotNil(vm.exportError)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testStagingNeverWritesTheOriginalOrSidecar() async throws {
      let original = directory.appendingPathComponent("Original.png")
      let originalBytes = Data([0x89, 0x50, 0x4E, 0x47])
      try originalBytes.write(to: original)
      let asset = AssetRef(url: original)
      let vm = BatchExportPanelVM(
        resolveSession: { EditSession(asset: $0) },
        exportData: { _, _ in Data([4, 3, 2, 1]) })

      await vm.begin(assets: [asset], in: directory).value

      XCTAssertNotNil(vm.stagedBatch)
      XCTAssertEqual(try Data(contentsOf: original), originalBytes)
      XCTAssertFalse(FileManager.default.fileExists(atPath: asset.sidecarURL!.path))
      vm.discardStagedBatch()
    }
  }
#endif
