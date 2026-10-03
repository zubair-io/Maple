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

  func testStaleFirstEditRefusesAnotherClientsConfirmedSave() async throws {
    try await exerciseStaleSave(semantic: true)
  }

  func testStaleOrdinarySaveRefusesAnotherClientsConfirmedSave() async throws {
    try await exerciseStaleSave(semantic: false)
  }

  private func exerciseStaleSave(semantic: Bool) async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let ref = try await fixture.image()
    let stale = SMBSidecarStore(source: fixture.source, ref: ref)
    let loaded = try await stale.load()
    var staleModel = loaded.0
    staleModel.exposure = 1.5
    let observer = SMBSource()
    try await observer.connect(credentials: fixture.credentials)
    let refs = try await observer.images()
    let observedRef = try XCTUnwrap(refs.first)
    let later = SMBSidecarStore(source: observer, ref: observedRef)
    let fresh = try await later.load()
    var freshModel = fresh.0
    freshModel.exposure = 2.25
    try await later.commitSemantic(
      model: freshModel, culling: fresh.1, action: "adjustment", label: "Another client's save")
    let expected = try await later.readWorkflowXML()
    do {
      if semantic {
        try await stale.commitSemantic(
          model: staleModel, culling: loaded.1, action: "adjustment", label: "Stale edit")
      } else {
        try await stale.writeConfirmed(model: staleModel, culling: loaded.1)
      }
      XCTFail("A stale editor must refresh before replacing another client's confirmed state")
    } catch {
      XCTAssertTrue(error.localizedDescription.lowercased().contains("refresh"))
    }
    let actual = try await later.readWorkflowXML()
    XCTAssertEqual(actual, expected)
    await observer.disconnect()
    await fixture.close()
  }

  func testQueuedEditsAdvanceOnlyThroughTheirOwnConfirmedDocuments() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let ref = try await fixture.image()
    let store = SMBSidecarStore(source: fixture.source, ref: ref)
    let loaded = try await store.load()
    var first = loaded.0
    first.exposure = 1
    var second = loaded.0
    second.exposure = 2
    let firstEdit = Task {
      try await store.commitSemantic(
        model: first, culling: loaded.1, action: "adjustment", label: "First")
    }
    // Both publications can be queued before the first server reply arrives.
    await Task.yield()
    let secondEdit = Task {
      try await store.commitSemantic(
        model: second, culling: loaded.1, action: "adjustment", label: "Second")
    }
    try await firstEdit.value
    try await secondEdit.value
    let xml = try await store.readWorkflowXML()
    let confirmed = try XCTUnwrap(xml)
    let record = try XCTUnwrap(WorkflowSidecarCore.read(xmp: confirmed))
    XCTAssertEqual(record.history.map(\.label), ["First", "Second"])
    XCTAssertEqual(try XMPParser.parse(confirmed).0.exposure, 2)
    let original = try await fixture.source.rawBytes(for: ref)
    XCTAssertEqual(original, fixture.original)
    await fixture.close()
  }

  func testOrdinarySaveRetriesTheIdenticalAcceptedDocument() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let proxy = try await OwnedSMBPublicationProxy.open(fixture)
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: proxy.credentials)
    let ref = try await fixture.image()
    let store = SMBSidecarStore(source: fixture.source, ref: ref)
    let loaded = try await store.load()
    var model = loaded.0
    model.exposure = 1.75
    try proxy.arm()
    do {
      try await store.writeConfirmed(model: model, culling: loaded.1)
      XCTFail("The accepted rename's network acknowledgement must be lost")
    } catch {
      XCTAssertTrue(proxy.droppedAcknowledgement)
    }
    let observer = SMBSource()
    try await observer.connect(credentials: fixture.credentials)
    let observed = try await observer.images()
    let observedRef = try XCTUnwrap(observed.first)
    let accepted = try await observer.readWorkflowSidecar(
      for: observedRef, variantId: WorkflowContract.primaryVariantID)
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    _ = try await fixture.image()
    await store.flush()
    let retried = try await store.readWorkflowXML()
    XCTAssertEqual(retried, accepted)
    XCTAssertEqual(try XMPParser.parse(XCTUnwrap(retried)).0.exposure, 1.75)
    await observer.disconnect()
    await proxy.close()
    await fixture.close()
  }

  private func exerciseLostAcknowledgement(concurrentSave: Bool) async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
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
    if concurrentSave {
      var next = model
      next.exposure = 3
      do {
        try await store.commitSemantic(
          model: next, culling: CullingState(), action: "adjustment", label: "Still stale")
        XCTFail("Recognizing an accepted UUID must not adopt another client's model implicitly")
      } catch {
        XCTAssertTrue(error.localizedDescription.lowercased().contains("refresh"))
      }
      let unchanged = try await observer.readWorkflowSidecar(
        for: observedRef, variantId: WorkflowContract.primaryVariantID)
      XCTAssertEqual(unchanged, expected)
    }
    let remoteOriginal = try await observer.rawBytes(for: observedRef)
    XCTAssertEqual(remoteOriginal, fixture.original)
    await observer.disconnect()
    await proxy.close()
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
