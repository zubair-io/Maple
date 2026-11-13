import Foundation
import XCTest

@testable import MapleCore

final class XMPSidecarDurableRecoveryTests: XCTestCase {
  func testConfirmedRetryAfterAcceptedPublicationDoesNotDuplicateHistory() async throws {
    try await exerciseRecovery(newGesture: false)
  }

  func testAnotherGestureAfterAcceptedPublicationDoesNotWedgeStore() async throws {
    try await exerciseRecovery(newGesture: true)
  }

  private func exerciseRecovery(newGesture: Bool) async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "durable-history-retry")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("photo.dng")
    let original = Data("untouched source".utf8)
    try original.write(to: raw)
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let failureFlag = directory.appendingPathComponent("fail-acknowledgement")
    try Data().write(to: failureFlag)
    // Every publication writes the real file. Only its acknowledgement is interrupted.
    let store = XMPSidecarStore(sidecarURL: sidecar) {
      if FileManager.default.fileExists(atPath: failureFlag.path) { throw POSIXError(.EIO) }
    }
    var model = AdjustmentModel.default
    model.exposure = 0.75
    do {
      try await store.commitSemantic(
        model: model, culling: CullingState(), action: "adjustment", label: "Exposure")
      XCTFail("Expected the acknowledgement to fail after publication")
    } catch {
      XCTAssertEqual((error as? POSIXError)?.code, .EIO)
    }
    let landed = try XCTUnwrap(
      WorkflowSidecarCore.read(
        xmp: String(contentsOf: sidecar, encoding: .utf8)))
    XCTAssertEqual(landed.history.count, 1)
    try FileManager.default.removeItem(at: failureFlag)
    if newGesture {
      model.exposure = 1.25
      try await store.commitSemantic(
        model: model, culling: CullingState(), action: "adjustment", label: "Exposure")
    } else {
      try await store.writeConfirmed(model: model, culling: CullingState())
    }
    let xml = try String(contentsOf: sidecar, encoding: .utf8)
    let confirmed = try XCTUnwrap(WorkflowSidecarCore.read(xmp: xml))
    XCTAssertEqual(confirmed.history.count, newGesture ? 2 : 1)
    XCTAssertEqual(confirmed.history.first, landed.history.first)
    XCTAssertEqual(Set(confirmed.history.map(\.id)).count, confirmed.history.count)
    XCTAssertEqual(try XMPParser.parse(xml).0.exposure, model.exposure)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }
}
