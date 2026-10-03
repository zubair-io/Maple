import CoreImage
import Foundation
import MapleBackup
import XCTest

@testable import MapleCore

@MainActor
final class NativeVariantExportTests: EditorTestCase {
  func testRealLocalAndPhotosExportsFollowSelectionAndPreserveOriginals() async throws {
    for photos in [false, true] {
      let files = try NativeWorkflowControlFixture.files()
      defer { try? FileManager.default.removeItem(at: files.directory) }
      let support = AppSupportSidecarStore(root: files.directory.appendingPathComponent("sidecars"))
      let primary =
        photos
        ? support.sidecarURL(phassetLocalId: "PHOTO/EXPORT")
        : SidecarPath.sidecarURL(for: files.raw)
      try FileManager.default.createDirectory(
        at: primary.deletingLastPathComponent(), withIntermediateDirectories: true)
      let input = NativeWorkflowControlFixture.input()
      try Data(input.utf8).write(to: primary)
      let raw = files.raw
      let asset =
        photos
        ? AssetRef(
          displayName: "photo.dng", hintExtension: "dng",
          bytesProvider: {
            try Data(contentsOf: raw)
          }) : AssetRef(url: raw)
      let session = EditSession(
        asset: asset,
        remoteSidecarStore: photos
          ? PhotoKitSidecarStore(phassetLocalId: "PHOTO/EXPORT", sidecars: support) : nil)
      await session.loadSidecar()
      let originalExport = try await exportedPixels(session)
      await session.workflow.createVariant(name: "Bright export", session: session)
      XCTAssertNil(session.workflow.errorText)
      let id = session.workflow.selectedVariantId
      session.beginEdit(description: "Bright exposure")
      session.model.exposure = 1.5
      session.endEdit()
      await session.flushPendingSidecarWrite()
      let namedExport = try await exportedPixels(session)
      XCTAssertNotEqual(namedExport, originalExport)
      await session.workflow.selectVariant(WorkflowContract.primaryVariantID, session: session)
      XCTAssertNil(session.workflow.errorText)
      let primaryAgain = try await exportedPixels(session)
      XCTAssertEqual(primaryAgain, originalExport)
      await session.workflow.selectVariant(id, session: session)
      XCTAssertNil(session.workflow.errorText)
      let namedAgain = try await exportedPixels(session)
      XCTAssertEqual(namedAgain, namedExport)
      XCTAssertEqual(try NativeWorkflowControlFixture.xml(primary), input)
      XCTAssertEqual(try Data(contentsOf: raw), files.original)
      _ = await session.latestRenderSchedule?.value
      await session.renderActor.cancelAll()
      await session.releaseTransientMemory()
    }
  }

  private func exportedPixels(_ session: EditSession) async throws -> Data {
    let image = try await session.renderForExport()
    return try XCTUnwrap(
      CIContext().pngRepresentation(
        of: image, format: .RGBA8,
        colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:]))
  }
}
