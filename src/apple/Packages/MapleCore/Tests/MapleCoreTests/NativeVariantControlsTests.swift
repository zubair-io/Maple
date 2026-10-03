import CoreImage
import Foundation
import MapleBackup
import XCTest

@testable import MapleCore

@MainActor
final class NativeVariantControlsTests: EditorTestCase {
  private typealias Fixture = NativeWorkflowControlFixture

  func testLocalAndPhotosCreateSelectSnapshotUndoAndReopenRealSiblings() async throws {
    for photos in [false, true] {
      let files = try Fixture.files()
      defer { try? FileManager.default.removeItem(at: files.directory) }
      let support = AppSupportSidecarStore(root: files.directory.appendingPathComponent("sidecars"))
      let photoID = "PHOTO/VARIANT/CONTROLS"
      let primary =
        photos
        ? support.sidecarURL(phassetLocalId: photoID)
        : SidecarPath.sidecarURL(for: files.raw)
      try FileManager.default.createDirectory(
        at: primary.deletingLastPathComponent(),
        withIntermediateDirectories: true)
      let input = Fixture.input()
      try Data(input.utf8).write(to: primary)
      let raw = files.raw
      let asset =
        photos
        ? AssetRef(
          displayName: "photo.dng", hintExtension: "dng", stableID: photoID,
          bytesProvider: { try Data(contentsOf: raw) }) : AssetRef(url: raw)
      let makeSession = {
        EditSession(
          asset: asset,
          remoteSidecarStore: photos
            ? PhotoKitSidecarStore(phassetLocalId: photoID, sidecars: support) : nil)
      }
      let session = makeSession()
      await session.workflow.reload(session: session)
      await session.workflow.createVariant(name: "Night", session: session)
      XCTAssertNil(session.workflow.errorText)
      let id = session.workflow.selectedVariantId
      XCTAssertNotEqual(id, WorkflowContract.primaryVariantID)
      let selected = try XCTUnwrap(session.asset.sidecarURL)
      XCTAssertEqual(try Fixture.record(selected).variantName, "Night")
      try await Fixture.fullFlow(session, path: selected)
      XCTAssertEqual(try Fixture.xml(primary), input)
      await session.workflow.selectVariant(WorkflowContract.primaryVariantID, session: session)
      XCTAssertNil(session.workflow.errorText)
      XCTAssertEqual(session.model.exposure, 0)
      XCTAssertTrue(session.undoHistory.isEmpty)
      await session.workflow.selectVariant(id, session: session)
      XCTAssertNil(session.workflow.errorText)
      XCTAssertEqual(session.model.exposure, 2)
      XCTAssertEqual(session.workflow.record?.snapshots.count, 1)
      let reopened = makeSession()
      await reopened.workflow.reload(session: reopened)
      XCTAssertEqual(reopened.workflow.variants.count, 2)
      await reopened.workflow.selectVariant(id, session: reopened)
      XCTAssertNil(reopened.workflow.errorText)
      XCTAssertEqual(reopened.model.exposure, 2)
      reopened.beginEdit(description: "Reopened exposure")
      reopened.model.exposure = 3
      reopened.endEdit()
      await reopened.flushPendingSidecarWrite()
      XCTAssertEqual(try XMPParser.parse(Fixture.xml(selected)).0.exposure, 3)
      XCTAssertEqual(try Fixture.record(selected).snapshots.count, 1)
      XCTAssertEqual(try Fixture.xml(primary), input)
      XCTAssertEqual(try Data(contentsOf: raw), files.original)
    }
  }

  func testSwitchSettlesOldQueuedGestureAndMissingVariantKeepsCurrentBinding() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let primary = SidecarPath.sidecarURL(for: files.raw)
    let input = Fixture.input()
    try Data(input.utf8).write(to: primary)
    let session = EditSession(asset: AssetRef(url: files.raw))
    await session.workflow.createVariant(name: "Night", session: session)
    XCTAssertNil(session.workflow.errorText)
    let id = session.workflow.selectedVariantId
    let selected = try XCTUnwrap(session.asset.sidecarURL)
    session.beginEdit(description: "Queued exposure")
    session.model.exposure = 2.5
    session.endEdit()
    await session.workflow.selectVariant(WorkflowContract.primaryVariantID, session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(try XMPParser.parse(Fixture.xml(selected)).0.exposure, 2.5)
    XCTAssertEqual(try Fixture.record(selected).history.count, 1)
    XCTAssertEqual(try Fixture.xml(primary), input)
    try FileManager.default.removeItem(at: selected)
    await session.workflow.selectVariant(id, session: session)
    XCTAssertNotNil(session.workflow.errorText)
    XCTAssertEqual(session.workflow.selectedVariantId, WorkflowContract.primaryVariantID)
    XCTAssertEqual(session.model.exposure, 0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path))
    XCTAssertEqual(try Data(contentsOf: files.raw), files.original)
  }

  func testActualPhotosRenderReusesOneDownloadAndRestoresBoundedCachedBranchPixels() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let support = AppSupportSidecarStore(root: files.directory.appendingPathComponent("sidecars"))
    let id = "PHOTO/CACHED/VARIANTS"
    let primary = support.sidecarURL(phassetLocalId: id)
    try FileManager.default.createDirectory(
      at: primary.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    let input = Fixture.input()
    try Data(input.utf8).write(to: primary)
    let raw = files.raw
    let downloads = VariantDownloadCount()
    let asset = AssetRef(
      displayName: "photo.dng", hintExtension: "dng", stableID: id,
      bytesProvider: {
        await downloads.record()
        return try Data(contentsOf: raw)
      })
    let session = EditSession(
      asset: asset,
      remoteSidecarStore: PhotoKitSidecarStore(phassetLocalId: id, sidecars: support))
    await session.loadSidecar()
    session.previewSize = CGSize(width: 64, height: 64)
    await session.renderActor.cancelAll()
    await session.decodeAndRender(targetSize: session.previewSize, phase: .fast, gen: nil)
    XCTAssertNil(session.renderError)
    let primaryImage = try XCTUnwrap(session.renderedPreview)
    session.workflow.previews.store(
      primaryImage, id: WorkflowContract.primaryVariantID,
      xml: input, model: session.model, width: 64)
    await session.workflow.createVariant(name: "Cached night", session: session)
    XCTAssertNil(session.workflow.errorText)
    let named = session.workflow.selectedVariantId
    let path = try XCTUnwrap(session.asset.sidecarURL)
    session.beginEdit(description: "Night exposure")
    session.model.exposure = 1.5
    session.endEdit()
    await session.flushPendingSidecarWrite()
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.cancelAll()
    await session.decodeAndRender(targetSize: session.previewSize, phase: .fast, gen: nil)
    XCTAssertNil(session.renderError)
    let namedImage = try XCTUnwrap(session.renderedPreview)
    let snapshot = await session.renderActor.snapshot(forAsset: session.asset)
    session.workflow.previews.store(
      namedImage, id: named, xml: try Fixture.xml(path),
      model: session.model, width: 64)
    await session.workflow.selectVariant(WorkflowContract.primaryVariantID, session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertTrue(session.renderedPreview === primaryImage)
    await session.workflow.selectVariant(named, session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertTrue(session.renderedPreview === namedImage)
    let warm = await session.renderActor.snapshot(forAsset: session.asset)
    XCTAssertTrue(warm.isFresh)
    XCTAssertEqual(warm.decodeGeneration, snapshot.decodeGeneration)
    let count = await downloads.count
    XCTAssertEqual(count, 1, "Variant switching must reuse the session-owned original bytes")
    XCTAssertEqual(try Fixture.xml(primary), input)
    XCTAssertEqual(try Data(contentsOf: raw), files.original)
  }

  func testOrdinaryNamedSaveReportsTheSelectedWriterFailure() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let primary = SidecarPath.sidecarURL(for: files.raw)
    let input = Fixture.input()
    try Data(input.utf8).write(to: primary)
    let session = EditSession(asset: AssetRef(url: files.raw))
    await session.workflow.createVariant(name: "Unwritable night", session: session)
    XCTAssertNil(session.workflow.errorText)
    let selected = try XCTUnwrap(session.asset.sidecarURL)
    try FileManager.default.removeItem(at: selected)
    try FileManager.default.createDirectory(at: selected, withIntermediateDirectories: false)
    session.model.exposure = 4
    await session.flushPendingSidecarWrite()
    let deadline = Date().addingTimeInterval(2)
    while session.sidecarError == nil, Date() < deadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertNotNil(session.sidecarError, "The UI must observe the selected writer's save errors")
    XCTAssertEqual(try Fixture.xml(primary), input)
    XCTAssertEqual(try Data(contentsOf: files.raw), files.original)
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.cancelAll()
    await session.releaseTransientMemory()
  }

  #if os(macOS)
    func testServerFolderAndCatalogControlsPublishAndDecodeTheSelectedConfirmedXML() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      for catalog in [false, true] {
        let source = try await fixture.stage(xml: Fixture.input())
        let raw = URL(fileURLWithPath: source.path)
        let original = try Data(contentsOf: raw)
        let primary = SidecarPath.sidecarURL(for: raw)
        let input = try Fixture.xml(primary)
        let asset = AssetRef(
          displayName: "photo.dng", hintExtension: "dng", stableID: source.id,
          bytesProvider: { try Data(contentsOf: raw) })
        let session = EditSession(
          asset: asset, remoteSidecarStore: fixture.store(source, catalog: catalog))
        await session.workflow.reload(session: session)
        await session.workflow.createVariant(name: "Server night", session: session)
        XCTAssertNil(session.workflow.errorText)
        let id = session.workflow.selectedVariantId
        let branch = try SidecarPath.variantURL(for: raw, variantId: id)
        let decodeXML = try XCTUnwrap(session.asset.sidecarURL)
        XCTAssertEqual(try Fixture.xml(decodeXML), try Fixture.xml(branch))
        let snapshot = try await Fixture.save(session)
        session.beginEdit(description: "Server exposure")
        session.model.exposure = 2.5
        session.endEdit()
        await session.flushPendingSidecarWrite()
        XCTAssertNil(session.sidecarError)
        session.workflow.prepareRestore(id: snapshot.id, snapshot: true)
        await session.workflow.reload(session: session)
        session.workflow.prepareRestore(id: snapshot.id, snapshot: true)
        await session.workflow.confirmRestore(session: session)
        XCTAssertNil(session.workflow.errorText)
        XCTAssertEqual(session.model.exposure, 0)
        session.undo()
        await session.flushPendingSidecarWrite()
        XCTAssertEqual(session.model.exposure, 2.5)
        XCTAssertEqual(try Fixture.xml(decodeXML), try Fixture.xml(branch))
        await session.workflow.selectVariant(WorkflowContract.primaryVariantID, session: session)
        XCTAssertNil(session.workflow.errorText)
        XCTAssertEqual(session.model.exposure, 0)
        await session.workflow.selectVariant(id, session: session)
        XCTAssertNil(session.workflow.errorText)
        XCTAssertEqual(session.model.exposure, 2.5)
        XCTAssertEqual(try Fixture.xml(primary), input)
        XCTAssertEqual(try Data(contentsOf: raw), original)
      }
    }
  #endif
}

private actor VariantDownloadCount {
  private(set) var count = 0
  func record() { count += 1 }
}
