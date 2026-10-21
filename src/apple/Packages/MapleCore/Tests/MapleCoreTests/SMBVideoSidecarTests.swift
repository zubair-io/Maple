import Foundation
import XCTest

@testable import MapleCore

/// #5053: over SMB a video keeps its full-name sidecar (`photo.mov.xmp`), so
/// it and a same-stem photo never read or write one shared `photo.xmp`.
@MainActor
final class SMBVideoSidecarTests: XCTestCase {
  func testAVideoAndItsSameStemPhotoKeepSeparateSidecars() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self, initialXML: nil)
    try Data("clip".utf8).write(to: fixture.share.appendingPathComponent("photo.mov"))
    let photoEdit = edit(exposure: 1)
    let videoEdit = edit(exposure: -1)

    try await fixture.source.writeSidecar(photoEdit, for: .init(path: "/photo.dng"))
    try await fixture.source.writeSidecar(videoEdit, for: .init(path: "/photo.mov"))

    XCTAssertEqual(try sidecar("photo.xmp", in: fixture), photoEdit)
    XCTAssertEqual(try sidecar("photo.mov.xmp", in: fixture), videoEdit)
    let videoBack = try await fixture.source.readSidecar(for: .init(path: "/photo.mov"))
    XCTAssertEqual(videoBack, videoEdit)
    let photoBack = try await fixture.source.readSidecar(for: .init(path: "/photo.dng"))
    XCTAssertEqual(photoBack, photoEdit)
  }

  func testAVideoEditAndItsWorkflowSidecarUseTheFullName() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self, initialXML: nil)
    try Data("clip".utf8).write(to: fixture.share.appendingPathComponent("photo.mov"))
    try Data("photo edit".utf8).write(to: fixture.share.appendingPathComponent("photo.xmp"))
    let video = ImageRef(id: "/photo.mov", displayName: "photo.mov")
    var model = AdjustmentModel.default
    model.exposure = 1

    try await fixture.source.writeXMP(Sidecar(model: model, culling: CullingState()), for: video)

    XCTAssertEqual(try sidecar("photo.xmp", in: fixture), Data("photo edit".utf8))
    let saved = try XCTUnwrap(String(data: try sidecar("photo.mov.xmp", in: fixture), encoding: .utf8))
    XCTAssertEqual(try XMPParser.parse(saved).0.exposure, 1)
    let primary = try await fixture.source.workflowSidecarPath(
      for: video, variantId: WorkflowContract.primaryVariantID)
    XCTAssertEqual(primary, "/photo.mov.xmp")
    let variantId = UUID().uuidString.lowercased()
    let variant = try await fixture.source.workflowSidecarPath(for: video, variantId: variantId)
    XCTAssertEqual(variant, "/photo.mov.v\(variantId).xmp")
  }

  private func edit(exposure: Double) -> Data {
    var model = AdjustmentModel.default
    model.exposure = exposure
    return Data(XMPSerializer.serialize(model: model, culling: CullingState()).utf8)
  }

  private func sidecar(_ name: String, in fixture: OwnedSMBWorkflowFixture) throws -> Data {
    try Data(contentsOf: fixture.share.appendingPathComponent(name))
  }
}
