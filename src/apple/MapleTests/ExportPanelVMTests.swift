// ExportPanelVMTests.swift — regression coverage for the editor's Export
// panel view-model (#3403: the iPhone Export button did nothing — the
// share affordance was wired to a no-op and the iOS export discarded its
// bytes). The encoder is injected so the file-staging contract runs
// without a RAW on disk.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

@MainActor
final class ExportPanelVMTests: XCTestCase {

  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("ExportPanelVMTests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  func testStageForSharingWritesTheEncodedFileAndPublishesIt() async throws {
    let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00])
    var received: ExportOptions?
    let vm = ExportPanelVM(encode: { _, options in
      received = options
      return bytes
    })
    vm.format = .heicP3
    vm.quality = 0.8
    let session = EditSession.preview(displayName: "DSC_0100.dng")

    await vm.stageForSharing(session: session, in: directory)

    XCTAssertNil(vm.exportError)
    XCTAssertFalse(vm.isExporting)
    let url = try XCTUnwrap(vm.stagedFile?.url)
    XCTAssertEqual(url.lastPathComponent, "\(session.asset.displayName).heic")
    XCTAssertEqual(
      url.deletingLastPathComponent().standardizedFileURL, directory.standardizedFileURL)
    XCTAssertEqual(try Data(contentsOf: url), bytes)
    XCTAssertEqual(received?.format, .heicP3)
    XCTAssertEqual(received?.quality, 0.8)
    XCTAssertNil(received?.maxSidePixels, "share exports are full resolution")
  }

  func testStageForSharingSurfacesEncoderFailureWithoutAFile() async throws {
    struct Boom: LocalizedError {
      var errorDescription: String? { "render exploded" }
    }
    let vm = ExportPanelVM(encode: { _, _ in throw Boom() })

    await vm.stageForSharing(session: EditSession.preview(), in: directory)

    XCTAssertNil(vm.stagedFile)
    XCTAssertEqual(vm.exportError, "render exploded")
    XCTAssertFalse(vm.isExporting)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
  }

  func testPerformClearsAPriorErrorBeforeRetrying() async {
    struct Boom: Error {}
    let vm = ExportPanelVM(encode: { _, _ in throw Boom() })
    await vm.stageForSharing(session: EditSession.preview(), in: directory)
    XCTAssertNotNil(vm.exportError)

    await vm.perform {}

    XCTAssertNil(vm.exportError)
    XCTAssertFalse(vm.isExporting)
  }

  func testOutputFileNameAndQualityControlFollowTheFormat() {
    let vm = ExportPanelVM()
    let asset = AssetRef.preview(displayName: "IMG_0042.dng")
    XCTAssertEqual(vm.outputFileName(for: asset), "\(asset.displayName).jpg")
    XCTAssertTrue(vm.showsQualityControl)

    vm.format = .tiff16
    XCTAssertEqual(vm.outputFileName(for: asset), "\(asset.displayName).tiff")
    XCTAssertFalse(vm.showsQualityControl)

    vm.format = .png
    XCTAssertFalse(vm.showsQualityControl)
  }
}
