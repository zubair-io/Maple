import Foundation
import XCTest

@testable import MapleCore

final class SMBWorkflowRecoveryTests: XCTestCase {
  func testAcceptedSemanticEditSurvivesLostNetworkAcknowledgementWithoutDuplicateHistory()
    async throws
  {
    try await exerciseLostAcknowledgement(concurrentSave: false)
  }

  func testAcceptedRetryPreservesAnotherClientsLaterSave() async throws {
    try await exerciseLostAcknowledgement(concurrentSave: true)
  }

  private func exerciseLostAcknowledgement(concurrentSave: Bool) async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open()
    let proxy = try await OwnedSMBPublicationProxy.open(fixture)
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: proxy.credentials)
    let ref = try await fixture.image()
    let store = SMBSidecarStore(source: fixture.source, ref: ref)
    var model = try await store.load().0
    model.exposure = 1.5
    try proxy.arm()
    do {
      try await store.commitSemantic(
        model: model, culling: CullingState(), action: "adjustment", label: "Captured exposure")
      XCTFail("The accepted rename's network acknowledgement must be lost")
    } catch {
      XCTAssertTrue(proxy.droppedAcknowledgement)
    }
    let observer = SMBSource()
    try await observer.connect(credentials: fixture.credentials)
    let observed = try await observer.images()
    let observedRef = try XCTUnwrap(observed.first)
    let acceptedXML = try await observer.readWorkflowSidecar(
      for: observedRef, variantId: WorkflowContract.primaryVariantID)
    let accepted = try XCTUnwrap(acceptedXML)
    let record = try XCTUnwrap(WorkflowSidecarCore.read(xmp: accepted))
    XCTAssertEqual(record.history.count, 1)
    XCTAssertEqual(try XMPParser.parse(accepted).0.exposure, 1.5)
    let expected = try await advanceIfNeeded(
      concurrentSave, accepted: accepted, source: observer, ref: observedRef)
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    _ = try await fixture.image()
    await store.flush()
    let retriedXML = try await store.readWorkflowXML()
    let retried = try XCTUnwrap(retriedXML)
    let retriedRecord = try XCTUnwrap(WorkflowSidecarCore.read(xmp: retried))
    XCTAssertEqual(retriedRecord.history.count, concurrentSave ? 2 : 1)
    XCTAssertEqual(retried, expected)
    XCTAssertEqual(XMPParser.parseMetadata(retried).caption, "Caption A")
    XCTAssertTrue(retried.contains("<foreign:Audit"))
    let remoteOriginal = try await observer.rawBytes(for: observedRef)
    XCTAssertEqual(remoteOriginal, fixture.original)
    await observer.disconnect()
    await fixture.close()
  }
  private func advanceIfNeeded(
    _ enabled: Bool, accepted: String, source: SMBSource, ref: ImageRef
  ) async throws -> String {
    guard enabled else { return accepted }
    let later = SMBSidecarStore(source: source, ref: ref)
    let loaded = try await later.load()
    var model = loaded.0
    model.exposure = 2.25
    try await later.commitSemantic(
      model: model, culling: loaded.1, action: "adjustment", label: "Another client's later save")
    let xml = try await later.readWorkflowXML()
    return try XCTUnwrap(xml)
  }

}
