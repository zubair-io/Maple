import CoreImage
import Foundation
import MapleBackup
import XCTest

@testable import MapleCore

@MainActor
final class WhiteBalanceWorkflowAcceptanceTests: EditorTestCase {
  func testEveryModePersistsUndoesReopensCopiesAndExportsRealRaw() async throws {
    for preset in WhiteBalancePreset.allCases {
      try await qualify(preset: preset)
    }
    try await qualify(preset: nil)
  }

  func testEveryModeUsesCanonicalPhotoKitSidecarAndCopiesWithoutChangingPixels() async throws {
    for preset in WhiteBalancePreset.allCases {
      try await qualify(preset: preset, photos: true)
    }
    try await qualify(preset: nil, photos: true)
  }

  func testAutoTonePersistsAsOneUndoActionOnLocalAndPhotoKitSidecars() async throws {
    for profile in [Profile.auto, .neutral] {
      try await qualify(preset: .auto, autoTone: true, profile: profile)
      try await qualify(preset: .auto, photos: true, autoTone: true, profile: profile)
    }
  }

  func testOneHundredConsecutiveCyclesOnLocalAndPhotoKitSidecars() async throws {
    for photos in [false, true] {
      let files = try NativeWorkflowControlFixture.files()
      defer { try? FileManager.default.removeItem(at: files.directory) }
      let backing = AppSupportSidecarStore(root: files.directory.appendingPathComponent("sidecars"))
      let path =
        photos
        ? backing.sidecarURL(phassetLocalId: "PHOTO/CYCLES")
        : SidecarPath.sidecarURL(for: files.raw)
      try FileManager.default.createDirectory(
        at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(NativeWorkflowControlFixture.input().utf8).write(to: path)
      let initial = makeSession(files.raw, photos: photos, backing: backing, id: "PHOTO/CYCLES")
      await initial.loadSidecar()
      try await RepeatedNativeWorkflowAssertions.qualify(
        initial: initial, adapter: photos ? "PhotoKit-sidecar" : "Filesystem",
        reopen: {
          let fresh = self.makeSession(
            files.raw, photos: photos, backing: backing, id: "PHOTO/CYCLES")
          await fresh.loadSidecar()
          return fresh
        }, readXML: { try NativeWorkflowControlFixture.xml(path) },
        verifyOriginal: { XCTAssertEqual(try Data(contentsOf: files.raw), files.original) })
    }
  }

  private func qualify(
    preset: WhiteBalancePreset?, photos: Bool = false, autoTone: Bool = false,
    profile: Profile = .auto
  ) async throws {
    let files = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let backing = AppSupportSidecarStore(root: files.directory.appendingPathComponent("sidecars"))
    let primary =
      photos
      ? backing.sidecarURL(phassetLocalId: "PHOTO/WB/SOURCE")
      : SidecarPath.sidecarURL(for: files.raw)
    try FileManager.default.createDirectory(
      at: primary.deletingLastPathComponent(), withIntermediateDirectories: true)
    let input = NativeWorkflowControlFixture.input().replacingOccurrences(
      of: "papp:Profile=\"Auto\"", with: "papp:Profile=\"\(profile.rawValue)\"")
    try Data(input.utf8).write(to: primary)
    let session = makeSession(files.raw, photos: photos, backing: backing, id: "PHOTO/WB/SOURCE")
    await session.loadSidecar()
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    if preset == .custom {
      // A real camera may seed tint beyond the manual slider bounds. Custom
      // and absolute copy retain that seed rather than clamp the existing look (#4067).
      await EditorState(session: session).applyWhiteBalancePreset(.asShot)
      await session.flushPendingSidecarWrite()
    }
    let before = session.model
    if autoTone {
      try await AutoToneWorkflowAssertions.apply(session)
    } else if let preset {
      await EditorState(session: session).applyWhiteBalancePreset(preset)
    } else {
      let picker = WhiteBalancePicker(session: session)
      picker.arm()
      await picker.pick(at: CGPoint(x: 0.25, y: 0.75))
      XCTAssertNil(picker.message)
      XCTAssertEqual(session.model.wbSource, .sampled)
      XCTAssertGreaterThan(session.model.wbAlgorithmVersion, 0)
    }
    let applied = session.model
    let label = autoTone ? "Auto Tone" : preset?.rawValue ?? "Sampled"
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError, label)
    let confirmed = try NativeWorkflowControlFixture.xml(primary)
    XCTAssertEqual(XMPParser.parseMetadata(confirmed).caption, "Caption A", label)
    XCTAssertTrue(confirmed.contains("<foreign:Audit"), label)
    let expectedPixels = try await pixels(session)
    XCTAssertEqual(try NativeWorkflowControlFixture.xml(primary), confirmed, label)

    if applied != before {
      session.undo()
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model, before, label)
      session.redo()
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model, applied, label)
      let replayedPixels = try await pixels(session)
      XCTAssertEqual(replayedPixels, expectedPixels, label)
    }
    let reopened = makeSession(files.raw, photos: photos, backing: backing, id: "PHOTO/WB/SOURCE")
    await reopened.loadSidecar()
    let roundtrip = try XMPParser.parse(
      XMPSerializer.serialize(model: applied, culling: session.culling)
    ).0
    XCTAssertEqual(reopened.model, roundtrip, label)
    let reopenedPixels = try await pixels(reopened)
    XCTAssertEqual(reopenedPixels, expectedPixels, label)

    let targetURL = files.directory.appendingPathComponent("copy.dng")
    try Data(files.original).write(to: targetURL)
    let target = makeSession(targetURL, photos: photos, backing: backing, id: "PHOTO/WB/TARGET")
    await target.loadSidecar()
    let patch = try AdjustmentTransfer.prepare(
      source: applied, groups: autoTone ? [.whiteBalance, .tone, .color] : [.whiteBalance],
      relativeWhiteBalance: false)
    try await target.applyAdjustmentTransfer(patch)
    let copied = try XMPParser.parse(
      NativeWorkflowControlFixture.xml(
        photos
          ? backing.sidecarURL(phassetLocalId: "PHOTO/WB/TARGET")
          : SidecarPath.sidecarURL(for: targetURL))
    ).0
    XCTAssertEqual(
      copied,
      try XMPParser.parse(
        XMPSerializer.serialize(model: patch.applying(to: .default), culling: CullingState())
      ).0, label)
    let copiedPixels = try await pixels(target)
    XCTAssertEqual(copiedPixels, expectedPixels, label)
    XCTAssertEqual(try Data(contentsOf: files.raw), files.original, label)
    XCTAssertEqual(try Data(contentsOf: targetURL), files.original, label)
    for current in [session, reopened, target] {
      _ = await current.latestRenderSchedule?.value
      await current.renderActor.cancelAll()
      await current.releaseTransientMemory()
    }
  }

  private func makeSession(
    _ raw: URL, photos: Bool, backing: AppSupportSidecarStore, id: String
  ) -> EditSession {
    let asset =
      photos
      ? AssetRef(
        displayName: raw.lastPathComponent, hintExtension: "dng", stableID: id,
        bytesProvider: { try Data(contentsOf: raw) })
      : AssetRef(url: raw)
    return EditSession(
      asset: asset,
      remoteSidecarStore: photos
        ? PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing) : nil)
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
