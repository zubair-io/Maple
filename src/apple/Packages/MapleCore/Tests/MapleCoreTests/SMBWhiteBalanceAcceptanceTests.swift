import CoreImage
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class SMBWhiteBalanceAcceptanceTests: EditorTestCase {
  func testEveryModePersistsUndoesReconnectsCopiesAndExportsSelectedVariant() async throws {
    for preset in WhiteBalancePreset.allCases {
      try await qualify(preset: preset)
    }
    try await qualify(preset: nil)
  }

  func testIdenticalNamesKeepIndependentSidecarsAfterRenameAndReconnect() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open()
    do {
      try await qualifyDuplicateNames(fixture)
      await fixture.close()
    } catch {
      await fixture.close()
      throw error
    }
  }

  func testOneHundredConsecutiveCyclesOnSelectedSMBVariant() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open()
    do {
      let ref = try await fixture.image()
      let initial = editor(fixture.source, ref)
      await initial.loadSidecar()
      await initial.workflow.createVariant(name: "100 cycles", session: initial)
      XCTAssertNil(initial.workflow.errorText)
      let variant = initial.workflow.selectedVariantId
      XCTAssertNotEqual(variant, WorkflowContract.primaryVariantID)
      let primary = try await fixture.source.readWorkflowSidecar(
        for: ref, variantId: WorkflowContract.primaryVariantID)
      try await RepeatedNativeWorkflowAssertions.qualify(
        initial: initial, adapter: "SMB-named-variant",
        reopen: {
          await fixture.source.disconnect()
          try await fixture.source.connect(credentials: fixture.credentials)
          let fresh = self.editor(fixture.source, try await fixture.image())
          await fresh.loadSidecar()
          await fresh.workflow.selectVariant(variant, session: fresh)
          XCTAssertNil(fresh.workflow.errorText)
          return fresh
        },
        readXML: {
          let xml = try await fixture.source.readWorkflowSidecar(for: ref, variantId: variant)
          return try XCTUnwrap(xml)
        },
        verifyOriginal: {
          XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
          let bytes = try await fixture.source.rawBytes(for: ref)
          XCTAssertEqual(bytes, fixture.original)
          let currentPrimary = try await fixture.source.readWorkflowSidecar(
            for: ref, variantId: WorkflowContract.primaryVariantID)
          XCTAssertEqual(currentPrimary, primary)
        })
      await fixture.close()
    } catch {
      await fixture.close()
      throw error
    }
  }

  private func qualifyDuplicateNames(_ fixture: OwnedSMBWorkflowFixture) async throws {
    let nested = fixture.share.appendingPathComponent("nested", isDirectory: true)
    try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
    let duplicate = nested.appendingPathComponent("photo.dng")
    try fixture.original.write(to: duplicate)
    try Data(NativeWorkflowControlFixture.input(tag: "B").utf8)
      .write(to: SidecarPath.sidecarURL(for: duplicate))
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    let images = try await fixture.source.images()
    let other = try XCTUnwrap(images.first { $0.smbPath?.contains("nested/") == true })
    let first = try XCTUnwrap(images.first { $0.smbPath?.contains("nested/") == false })
    XCTAssertEqual(first.id, other.id)
    XCTAssertEqual(first.displayName, other.displayName)
    XCTAssertNotEqual(first, other)
    let store = SMBSidecarStore(source: fixture.source, ref: first)
    let loaded = try await store.load()
    var model = loaded.0
    model.exposure = 1.5
    try await store.writeConfirmed(model: model, culling: loaded.1)
    let secondXML = try await fixture.source.readWorkflowSidecar(
      for: other, variantId: WorkflowContract.primaryVariantID)
    XCTAssertEqual(secondXML, NativeWorkflowControlFixture.input(tag: "B"))
    _ = try await fixture.source.renameAsset(first, to: "renamed.dng")
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    let relisted = try await fixture.source.images()
    let renamed = try XCTUnwrap(relisted.first { $0.displayName == "renamed.dng" })
    _ = try await fixture.source.renameAsset(renamed, to: "final.dng")
    let renamedXML = try await fixture.source.readWorkflowSidecar(
      for: first, variantId: WorkflowContract.primaryVariantID)
    let confirmed = try XCTUnwrap(renamedXML)
    XCTAssertEqual(try XMPParser.parse(confirmed).0.exposure, 1.5)
    XCTAssertEqual(XMPParser.parseMetadata(confirmed).caption, "Caption A")
    let secondAfter = try await fixture.source.readWorkflowSidecar(
      for: other, variantId: WorkflowContract.primaryVariantID)
    XCTAssertEqual(secondAfter, secondXML)
    XCTAssertEqual(try Data(contentsOf: duplicate), fixture.original)
    XCTAssertEqual(
      try Data(contentsOf: fixture.share.appendingPathComponent("final.dng")), fixture.original)
    let firstBytes = try await fixture.source.rawBytes(for: first)
    let otherBytes = try await fixture.source.rawBytes(for: other)
    XCTAssertEqual(firstBytes, fixture.original)
    XCTAssertEqual(otherBytes, fixture.original)
  }

  func testAutoTonePersistsAsOneUndoActionOnSelectedSMBVariant() async throws {
    for profile in [Profile.auto, .neutral] {
      try await qualify(preset: .auto, autoTone: true, profile: profile)
    }
  }

  private func qualify(
    preset: WhiteBalancePreset?, autoTone: Bool = false, profile: Profile = .auto
  ) async throws {
    let input = NativeWorkflowControlFixture.input().replacingOccurrences(
      of: "papp:Profile=\"Auto\"", with: "papp:Profile=\"\(profile.rawValue)\"")
    let fixture = try await OwnedSMBWorkflowFixture.open(initialXML: input)
    do {
      try await qualify(preset: preset, fixture: fixture, autoTone: autoTone)
      await fixture.close()
    } catch {
      await fixture.close()
      throw error
    }
  }

  private func qualify(
    preset: WhiteBalancePreset?, fixture: OwnedSMBWorkflowFixture, autoTone: Bool
  ) async throws {
    let label = autoTone ? "Auto Tone" : preset?.rawValue ?? "Sampled"
    let copy = fixture.share.appendingPathComponent("copy.dng")
    try fixture.original.write(to: copy)
    try Data(NativeWorkflowControlFixture.input(tag: "B").utf8)
      .write(to: SidecarPath.sidecarURL(for: copy))
    // Re-list the actual server after creating the target fixture file.
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    let sourceRef = try await fixture.image()
    let images = try await fixture.source.images()
    let targetRef = try XCTUnwrap(images.first { $0.displayName == "copy.dng" })
    XCTAssertEqual(sourceRef.id, targetRef.id, "Identical RAW copies share content identity")
    XCTAssertNotEqual(sourceRef.smbPath, targetRef.smbPath)
    let session = editor(fixture.source, sourceRef)
    await session.loadSidecar()
    await session.workflow.createVariant(name: label, session: session)
    XCTAssertNil(session.workflow.errorText, label)
    let variant = session.workflow.selectedVariantId
    XCTAssertNotEqual(variant, WorkflowContract.primaryVariantID, label)
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    if preset == .custom {
      await EditorState(session: session).applyWhiteBalancePreset(.asShot)
      await session.flushPendingSidecarWrite()
    }
    let primaryBefore = try await fixture.source.readWorkflowSidecar(
      for: sourceRef, variantId: WorkflowContract.primaryVariantID)
    let before = session.model
    if autoTone {
      try await AutoToneWorkflowAssertions.apply(session)
    } else if let preset {
      await EditorState(session: session).applyWhiteBalancePreset(preset)
    } else {
      let picker = WhiteBalancePicker(session: session)
      picker.arm()
      await picker.pick(at: CGPoint(x: 0.25, y: 0.75))
      XCTAssertNil(picker.message, label)
      XCTAssertEqual(session.model.wbSource, .sampled, label)
      XCTAssertGreaterThan(session.model.wbAlgorithmVersion, 0, label)
    }
    let applied = session.model
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError, label)
    let variantXML = try await fixture.source.readWorkflowSidecar(
      for: sourceRef, variantId: variant)
    let confirmed = try XCTUnwrap(variantXML)
    XCTAssertEqual(XMPParser.parseMetadata(confirmed).caption, "Caption A", label)
    XCTAssertTrue(confirmed.contains("<foreign:Audit"), label)
    let expectedPixels = try await pixels(session)
    if before != applied {
      session.undo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.sidecarError, label)
      XCTAssertEqual(session.model, before, label)
      session.redo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.sidecarError, label)
      XCTAssertEqual(session.model, applied, label)
      let replayed = try await pixels(session)
      XCTAssertEqual(replayed, expectedPixels, label)
    }
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    let reopened = editor(fixture.source, try await fixture.image())
    await reopened.loadSidecar()
    await reopened.workflow.selectVariant(variant, session: reopened)
    XCTAssertNil(reopened.workflow.errorText, label)
    let roundtrip = try XMPParser.parse(
      XMPSerializer.serialize(model: applied, culling: session.culling)
    ).0
    XCTAssertEqual(reopened.model, roundtrip, label)
    let reopenedPixels = try await pixels(reopened)
    XCTAssertEqual(reopenedPixels, expectedPixels, label)

    let target = editor(fixture.source, targetRef)
    await target.loadSidecar()
    let patch = try AdjustmentTransfer.prepare(
      source: applied, groups: autoTone ? [.whiteBalance, .tone, .color] : [.whiteBalance],
      relativeWhiteBalance: false)
    try await target.applyAdjustmentTransfer(patch)
    XCTAssertNil(target.sidecarError, label)
    let targetXML = try await fixture.source.readWorkflowSidecar(
      for: targetRef, variantId: WorkflowContract.primaryVariantID)
    let copiedXML = try XCTUnwrap(targetXML)
    XCTAssertEqual(XMPParser.parseMetadata(copiedXML).caption, "Caption B", label)
    XCTAssertTrue(copiedXML.contains("<foreign:Audit"), label)
    let copied = try XMPParser.parse(copiedXML).0
    XCTAssertEqual(
      copied,
      try XMPParser.parse(
        XMPSerializer.serialize(model: patch.applying(to: .default), culling: CullingState())
      ).0,
      label)
    let copiedPixels = try await pixels(target)
    XCTAssertEqual(copiedPixels, expectedPixels, label)
    let primary = try await fixture.source.readWorkflowSidecar(
      for: sourceRef, variantId: WorkflowContract.primaryVariantID)
    XCTAssertEqual(primary, primaryBefore, label)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original, label)
    XCTAssertEqual(try Data(contentsOf: copy), fixture.original, label)
    let sourceBytes = try await fixture.source.rawBytes(for: sourceRef)
    let targetBytes = try await fixture.source.rawBytes(for: targetRef)
    XCTAssertEqual(sourceBytes, fixture.original, label)
    XCTAssertEqual(targetBytes, fixture.original, label)
    for current in [session, reopened, target] {
      _ = await current.latestRenderSchedule?.value
      await current.renderActor.cancelAll()
      await current.releaseTransientMemory()
    }
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

  private func pixels(_ session: EditSession) async throws -> [UInt8] {
    let image = try await session.renderForExport()
    let width = Int(image.extent.width)
    let height = Int(image.extent.height)
    var output = [UInt8](repeating: 0, count: width * height * 4)
    output.withUnsafeMutableBytes {
      CIContext(options: [.cacheIntermediates: false]).render(
        image, toBitmap: $0.baseAddress!, rowBytes: width * 4,
        bounds: image.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    return output
  }
}
