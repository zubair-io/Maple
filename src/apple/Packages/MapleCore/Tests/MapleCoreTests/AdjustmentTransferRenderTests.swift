import CoreImage
import XCTest

@testable import MapleCore

@MainActor
final class AdjustmentTransferRenderTests: XCTestCase {
  private var fixtures: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("test-fixtures/batch-transfer")
  }

  func testCameraBaselineRoundsNegativeHalfTintAwayFromZero() {
    XCTAssertEqual(
      WhiteBalanceTransferBaseline.cameraBaseline(temperature: 5025, tint: -2.5),
      .init(temperature: 5050, tint: -3))
  }

  func testActualCameraBaselinesAndPairedTransferRenderThroughNativeEditor() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "paired-transfer")
    defer { try? FileManager.default.removeItem(at: root) }
    let sourceURL = root.appendingPathComponent("source.dng")
    let targetURL = root.appendingPathComponent("target.dng")
    try FileManager.default.copyItem(
      at: fixtures.appendingPathComponent("source.dng"), to: sourceURL)
    try FileManager.default.copyItem(
      at: fixtures.appendingPathComponent("target.dng"), to: targetURL)
    let sourceBytes = try Data(contentsOf: sourceURL)
    let targetBytes = try Data(contentsOf: targetURL)
    let sourceAsset = AssetRef(url: sourceURL)
    let targetAsset = AssetRef(url: targetURL)
    let sourceBaseline = try await WhiteBalanceTransferBaseline.read(asset: sourceAsset)
    let targetBaseline = try await WhiteBalanceTransferBaseline.read(asset: targetAsset)
    XCTAssertEqual(sourceBaseline, .init(temperature: 7350, tint: 14))
    XCTAssertEqual(targetBaseline, .init(temperature: 5050, tint: 38))
    let remote = AssetRef(
      displayName: "Target from connected library", hintExtension: "dng",
      explicitIsRaw: true, bytesProvider: { targetBytes })
    // A real embedded calibration frame is required: a frameless synthetic
    // RAW would compare CIRAWFilter's local fallback against an unseeded remote
    // fallback, rather than testing the same camera-relative correction.
    let decoded = try PipelineRenderer.renderSceneLinear(
      rawBytes: targetBytes, hint: "dng", quality: .full, profileOverride: .neutral)
    XCTAssertTrue(
      decoded.wbFrame?.isPresent == true, "The fixture must export its calibration frame")
    let remoteBaseline = try await WhiteBalanceTransferBaseline.read(asset: remote)
    XCTAssertEqual(remoteBaseline, targetBaseline)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: sourceURL).path))
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: targetURL).path))

    var source = AdjustmentModel.default
    source.temperature = sourceBaseline.temperature + 1200
    source.tint = sourceBaseline.tint + 10
    source.wbSource = .manual
    source.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75)
    let patch = try AdjustmentTransfer.prepare(
      source: source, groups: [.whiteBalance, .geometry],
      relativeWhiteBalance: true, sourceBaseline: sourceBaseline, targetBaseline: targetBaseline)
    _ = try XMPParser.parse(XMPSerializer.serialize(model: source, culling: CullingState()))
    let target = EditSession(asset: targetAsset)
    await target.loadSidecar()
    // Isolate WB and crop from camera-preview Auto fitting.
    target.model.profile = .neutral
    try await target.applyAdjustmentTransfer(patch)
    let savedXML = try String(contentsOf: SidecarPath.sidecarURL(for: targetURL), encoding: .utf8)
    _ = try XMPParser.parse(savedXML)
    let actual = try await target.renderForExport()
    let postXML = try String(contentsOf: SidecarPath.sidecarURL(for: targetURL), encoding: .utf8)
    XCTAssertEqual(postXML, savedXML, "Rendering must leave the confirmed sidecar unchanged")
    _ = try XMPParser.parse(postXML)
    XCTAssertEqual(actual.extent.size, CGSize(width: 40, height: 60))
    let (saved, _) = try await XMPSidecarStore(rawURL: targetURL).load()
    XCTAssertEqual(saved.temperature, 6250)
    XCTAssertEqual(saved.tint, 48)
    XCTAssertEqual(saved.crop, source.crop)

    // Independently authored target values are the oracle, not reusing merge.
    var authored = AdjustmentModel.default
    authored.profile = .neutral
    authored.temperature = 6250
    authored.tint = 48
    authored.wbSource = .manual
    authored.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75)
    let expectedSession = EditSession(asset: remote, model: authored, culling: CullingState())
    let expected = try await expectedSession.renderForExport()
    let actualPixels = pixels(actual)
    let expectedPixels = pixels(expected)
    XCTAssertTrue(
      actualPixels == expectedPixels,
      "Native target and independently authored target pixels differ: \(actualPixels.prefix(4)) / \(expectedPixels.prefix(4))"
    )
    var absolute = authored
    absolute.temperature = 8550
    absolute.tint = 24
    let absoluteSession = EditSession(asset: remote, model: absolute, culling: CullingState())
    let absoluteImage = try await absoluteSession.renderForExport()
    XCTAssertNotEqual(
      pixels(actual), pixels(absoluteImage),
      "Relative and absolute corrections must produce different target pixels")
    XCTAssertEqual(try Data(contentsOf: sourceURL), sourceBytes)
    XCTAssertEqual(try Data(contentsOf: targetURL), targetBytes)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: sourceURL).path))
  }

  private func pixels(_ image: CIImage) -> [UInt8] {
    let width = Int(image.extent.width)
    let height = Int(image.extent.height)
    var result = [UInt8](repeating: 0, count: width * height * 4)
    result.withUnsafeMutableBytes {
      CIContext(options: [.cacheIntermediates: false]).render(
        image, toBitmap: $0.baseAddress!,
        rowBytes: width * 4, bounds: image.extent, format: .RGBA8,
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    return result
  }
}
