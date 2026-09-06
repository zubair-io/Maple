import XCTest

@testable import MapleCore

@MainActor
final class WhiteBalanceAuthoringParityTests: XCTestCase {
  /// The golden is the actual Web Download XMP result after choosing WB Auto
  /// on the committed gray DNG, using the release gpu,parallel WASM build.
  /// This gate runs Apple's real FFI analysis, canonical serializer and Metal
  /// chain. A missing fixture or GPU fails; nothing here skip-passes.
  func testNativeAutoAndWebAutoSidecarsRenderIdenticallyOnMetal() async throws {
    let fixtures = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("MapleUITests/Fixtures")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let raw = directory.appendingPathComponent("grey.dng")
    try FileManager.default.copyItem(
      at: fixtures.appendingPathComponent("synthetic/grey-l018-rggb.dng"), to: raw)
    let webXML = try String(
      contentsOf: fixtures.appendingPathComponent("white-balance/grey-auto-web.xmp"),
      encoding: .utf8)
    let (web, _) = try XMPParser.parse(webXML)
    let editor = EditorState(session: EditSession(asset: AssetRef(url: raw)))
    let session = editor.session
    addTeardownBlock {
      await session.renderActor.awaitCurrentRenderIfInFlight()
      await session.renderActor.cancelAll()
      await session.releaseTransientMemory()
      try? FileManager.default.removeItem(at: directory)
    }
    await editor.applyWhiteBalancePreset(.auto)
    XCTAssertEqual(editor.session.model.wbSource, .auto)
    XCTAssertEqual(editor.session.undoHistory.count, 1, "Native analysis must really run")
    let nativeXML = XMPSerializer.serialize(model: editor.session.model, culling: CullingState())
    let (native, _) = try XMPParser.parse(nativeXML)
    XCTAssertEqual(native.temperature, web.temperature)
    XCTAssertEqual(native.tint, web.tint)
    XCTAssertEqual(native.whiteBalancePreset, web.whiteBalancePreset)
    XCTAssertEqual(native.wbSource, web.wbSource)
    XCTAssertEqual(native.wbScaleVersion, web.wbScaleVersion)
    XCTAssertEqual(native.wbAlgorithmVersion, web.wbAlgorithmVersion)

    let pixels: [Float] = (0..<256).flatMap { index -> [Float] in
      let red = Float(index % 16) / 15
      let green = Float(index / 16) / 15
      let blue = Float(index % 7) / 6
      return [red, green, blue, 1]
    }
    let gpu = try GpuLiveSession(pixels: pixels, width: 16, height: 16)
    let nativeOutput = try await gpu.renderToBuffer(model: native)
    let webOutput = try await gpu.renderToBuffer(model: web)
    let output = try XCTUnwrap(nativeOutput)
    XCTAssertEqual(output.count, 16 * 16 * 3)
    XCTAssertGreaterThan(Int(output.max() ?? 0) - Int(output.min() ?? 0), 80)
    XCTAssertEqual(
      nativeOutput, webOutput, "Both authored sidecars must produce the same GPU pixels")
  }
}
