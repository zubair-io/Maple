import CoreImage
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class SMBWorkflowAcceptanceTests: EditorTestCase {
  func testConnectedEditorHistorySnapshotsVariantsReopenAndExportPreserveOriginal() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let ref = try await fixture.image()
    let session = editor(fixture.source, ref)
    await session.loadSidecar()
    XCTAssertNil(session.sidecarError)
    let primaryPixels = try await pixels(session)
    await session.workflow.createVariant(name: "SMB branch", session: session)
    XCTAssertNil(session.workflow.errorText)
    let id = session.workflow.selectedVariantId
    XCTAssertNotEqual(id, WorkflowContract.primaryVariantID)
    session.beginEdit(description: "Bright exposure")
    session.model.exposure = 1.5
    session.endEdit()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    let bright = try await pixels(session)
    XCTAssertNotEqual(bright, primaryPixels)
    await session.workflow.reload(session: session)
    XCTAssertEqual(session.workflow.record?.history.map(\.action), ["adjustment"])
    await session.workflow.saveSnapshot(name: "Saved bright", session: session)
    XCTAssertNil(session.workflow.errorText)
    let saved = try XCTUnwrap(session.workflow.record?.snapshots.first)
    session.beginEdit(description: "Darker exposure")
    session.model.exposure = -1
    session.endEdit()
    await session.flushPendingSidecarWrite()
    let dark = try await pixels(session)
    XCTAssertNotEqual(dark, bright)
    // Opening/refreshing the product workflow panel reads its confirmed document.
    await session.workflow.reload(session: session)
    session.workflow.prepareRestore(id: saved.id, snapshot: true)
    await session.workflow.confirmRestore(session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(session.model.exposure, 1.5)
    let restored = try await pixels(session)
    XCTAssertEqual(restored, bright)
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    let undone = try await pixels(session)
    XCTAssertEqual(undone, dark)
    session.redo()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    let redone = try await pixels(session)
    XCTAssertEqual(redone, bright)
    await session.workflow.selectVariant(WorkflowContract.primaryVariantID, session: session)
    XCTAssertNil(session.workflow.errorText)
    let primaryAgain = try await pixels(session)
    XCTAssertEqual(primaryAgain, primaryPixels)
    let primary = try await fixture.source.readWorkflowSidecar(
      for: ref, variantId: WorkflowContract.primaryVariantID)
    XCTAssertEqual(primary, NativeWorkflowControlFixture.input())
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    let reconnectedRef = try await fixture.image()
    XCTAssertEqual(reconnectedRef.id, ref.id)
    let reopened = editor(fixture.source, reconnectedRef)
    await reopened.loadSidecar()
    await reopened.workflow.selectVariant(id, session: reopened)
    XCTAssertNil(reopened.workflow.errorText)
    XCTAssertEqual(reopened.model.exposure, 1.5)
    let reopenedPixels = try await pixels(reopened)
    XCTAssertEqual(reopenedPixels, bright)
    let selectedXML = try await fixture.source.readWorkflowSidecar(
      for: reconnectedRef, variantId: id)
    let xml = try XCTUnwrap(selectedXML)
    XCTAssertEqual(XMPParser.parseMetadata(xml).caption, "Caption A")
    XCTAssertTrue(xml.contains("<foreign:Audit"))
    let record = try XCTUnwrap(WorkflowSidecarCore.read(xmp: xml))
    XCTAssertEqual(record.snapshots.count, 1)
    XCTAssertEqual(
      record.history.map(\.action),
      ["adjustment", "adjustment", "snapshot-restore", "undo", "redo"])
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    let remoteOriginal = try await fixture.source.rawBytes(for: reconnectedRef)
    XCTAssertEqual(remoteOriginal, fixture.original)
    await session.renderActor.cancelAll()
    await reopened.renderActor.cancelAll()
    await session.releaseTransientMemory()
    await reopened.releaseTransientMemory()
    await fixture.close()
  }

  private func editor(_ source: SMBSource, _ ref: ImageRef) -> EditSession {
    let asset = AssetRef(
      displayName: ref.displayName, hintExtension: "dng", stableID: ref.id,
      thumbnailProvenance: .smb, bytesProvider: { try await source.rawBytes(for: ref) })
    let session = EditSession(
      asset: asset, remoteSidecarStore: SMBSidecarStore(source: source, ref: ref))
    session.announcer = RecordingAnnouncer()
    return session
  }
  private func pixels(_ session: EditSession) async throws -> Data {
    let image = try await session.renderForExport()
    return try XCTUnwrap(
      CIContext().pngRepresentation(
        of: image, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:]))
  }
}
