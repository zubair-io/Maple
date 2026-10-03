import CoreImage
import Foundation
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

  private func qualify(preset: WhiteBalancePreset?) async throws {
    let files = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let primary = SidecarPath.sidecarURL(for: files.raw)
    let input = NativeWorkflowControlFixture.input()
    try Data(input.utf8).write(to: primary)
    let session = EditSession(asset: AssetRef(url: files.raw))
    await session.loadSidecar()
    await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    if preset == .custom {
      // A real camera may seed tint beyond the manual slider bounds. Custom
      // and absolute copy retain that seed rather than clamp the existing look (#4067).
      await EditorState(session: session).applyWhiteBalancePreset(.asShot)
      await session.flushPendingSidecarWrite()
    }
    let before = session.model
    if let preset {
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
    let label = preset?.rawValue ?? "Sampled"
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
    let reopened = EditSession(asset: AssetRef(url: files.raw))
    await reopened.loadSidecar()
    let roundtrip = try XMPParser.parse(
      XMPSerializer.serialize(model: applied, culling: session.culling)
    ).0
    XCTAssertEqual(reopened.model, roundtrip, label)
    let reopenedPixels = try await pixels(reopened)
    XCTAssertEqual(reopenedPixels, expectedPixels, label)

    let targetURL = files.directory.appendingPathComponent("copy.dng")
    try Data(files.original).write(to: targetURL)
    let target = EditSession(asset: AssetRef(url: targetURL))
    await target.loadSidecar()
    let patch = try AdjustmentTransfer.prepare(
      source: applied, groups: [.whiteBalance], relativeWhiteBalance: false)
    try await target.applyAdjustmentTransfer(patch)
    let copied = try XMPParser.parse(
      NativeWorkflowControlFixture.xml(SidecarPath.sidecarURL(for: targetURL))
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
      await current.latestRenderSchedule?.value
      await current.renderActor.cancelAll()
      await current.releaseTransientMemory()
    }
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
