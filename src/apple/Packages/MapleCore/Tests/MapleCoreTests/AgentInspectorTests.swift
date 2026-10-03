// AgentInspectorTests — maple_render_and_inspect returns a JPEG and metrics
// computed from the same pixels, honours ROI/size limits, and refuses to
// report a render the state has already moved past.

import CoreImage
import ImageIO
import MapleAgentWire
import XCTest

@testable import MapleCore

@MainActor
final class AgentInspectorTests: XCTestCase {
  private let context = CIContext(options: [.workingColorSpace: NSNull()])

  /// Left half pure white, right half pure black, in sRGB.
  private func splitImage(width: Int = 400, height: Int = 200) -> CIImage {
    let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1))
      .cropped(to: CGRect(x: 0, y: 0, width: width / 2, height: height))
    let black = CIImage(color: CIColor(red: 0, green: 0, blue: 0))
      .cropped(to: CGRect(x: width / 2, y: 0, width: width / 2, height: height))
    return white.composited(over: black)
  }

  func testMetricsDescribeDisplayOccupancy() {
    var rgba = [UInt8]()
    for _ in 0..<3 { rgba += [255, 255, 255, 255] }
    rgba += [0, 0, 0, 255]
    let metrics = AgentInspector.metrics(rgba: rgba, width: 2, height: 2)
    XCTAssertEqual(metrics["near_white_fraction"], 0.75)
    XCTAssertEqual(metrics["near_black_fraction"], 0.25)
    XCTAssertEqual(metrics["luma_percentiles"]?["p01"], 0)
    XCTAssertEqual(metrics["luma_percentiles"]?["p50"], 1)
    XCTAssertEqual(metrics["channel_means"]?["g"], 0.75)
    XCTAssertEqual(metrics["mean_chroma"], 0)
  }

  func testInspectScalesToMaxEdgeAndMeasuresTheSamePixels() throws {
    let inspection = try AgentInspector.inspect(
      splitImage(), maxEdge: 256, region: nil, context: context)
    XCTAssertEqual(inspection.width, 256)
    XCTAssertEqual(inspection.height, 128)
    XCTAssertEqual(inspection.metrics["near_white_fraction"]?.numberValue ?? 0, 0.5, accuracy: 0.02)
    XCTAssertEqual(inspection.metrics["near_black_fraction"]?.numberValue ?? 0, 0.5, accuracy: 0.02)
    let source = try XCTUnwrap(CGImageSourceCreateWithData(inspection.jpeg as CFData, nil))
    let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    XCTAssertEqual(decoded.width, 256)
    XCTAssertEqual(decoded.height, 128)
  }

  func testRegionUsesTopLeftNormalizedCoordinates() throws {
    let leftHalf = try AgentInspector.inspect(
      splitImage(), maxEdge: 1024,
      region: .init(x: 0, y: 0, width: 0.5, height: 1), context: context)
    XCTAssertEqual(leftHalf.width, 200)
    XCTAssertEqual(leftHalf.metrics["near_white_fraction"], 1)

    let image = splitImage()
    let top = CIImage(color: CIColor(red: 1, green: 0, blue: 0))
      .cropped(to: CGRect(x: 0, y: 100, width: 400, height: 100))
    let topBand = try AgentInspector.inspect(
      top.composited(over: image), maxEdge: 1024,
      region: .init(x: 0, y: 0, width: 1, height: 0.5), context: context)
    XCTAssertEqual(topBand.metrics["channel_means"]?["r"], 1)
    XCTAssertEqual(topBand.metrics["channel_means"]?["g"], 0)
  }

  func testArgumentValidationRejectsBadSizeAndRegion() {
    XCTAssertEqual(try AgentInspector.parseMaxEdge(nil), 1024)
    XCTAssertThrowsError(try AgentInspector.parseMaxEdge(4096))
    XCTAssertThrowsError(try AgentInspector.parseMaxEdge(512.5))
    XCTAssertThrowsError(
      try AgentInspector.Region.parse(["x": 0.8, "y": 0, "width": 0.5, "height": 0.5]))
    XCTAssertThrowsError(try AgentInspector.Region.parse(["x": 0]))
  }

  func testSizeValidationRejectsHugeNonfiniteAndFractionalNumbersWithoutTrapping() throws {
    for value in [
      1e100, -1e100, .infinity, -.infinity, .nan, 256.5,
      Double(Int.max), Double(Int.min), 255, 2049,
    ] {
      XCTAssertThrowsError(try AgentInspector.parseMaxEdge(.number(value))) { error in
        XCTAssertEqual((error as? AgentError)?.code, "invalid_arguments")
      }
    }
    for value in [256, 1024, 2048] {
      XCTAssertEqual(try AgentInspector.parseMaxEdge(.int(value)), value)
    }
  }

  func testInvalidSizeOverRealWireLeavesTheAppServing() async throws {
    let service = AgentEditService()
    let socket = "/tmp/agent-size-\(UUID().uuidString.prefix(8)).sock"
    let server = AgentSocketServer(path: socket) { await service.handle($0) }
    try server.start()
    defer { server.stop() }
    let client = AgentSocketClient(path: socket, timeout: 5)
    let responses = try await Task.detached {
      try [1e100, -1e100, 256.5].enumerated().map { index, value in
        try client.send(
          AgentRequest(
            id: index, tool: "maple_render_and_inspect",
            arguments: ["max_edge": .number(value)]))
      } + [client.send(AgentRequest(id: 9, tool: "maple_get_active_photo", arguments: [:]))]
    }.value
    for response in responses.prefix(3) {
      guard case .failure(let error) = response.outcome else { return XCTFail("expected failure") }
      XCTAssertEqual(error.code, "invalid_arguments")
    }
    guard case .failure(let error) = responses.last?.outcome else {
      return XCTFail("expected normal no-photo reply")
    }
    XCTAssertEqual(error.code, "no_active_photo")
  }

  func testServiceInspectsTheCanvasAndTagsTheRevision() async throws {
    let session = EditSession(
      asset: AssetRef(displayName: "t.dng", hintExtension: "dng") { Data() },
      model: .default, culling: CullingState())
    let service = AgentEditService()
    service.activate(session)

    let empty = await service.handle(
      AgentRequest(id: 1, tool: "maple_render_and_inspect", arguments: [:]))
    guard case .failure(let error) = empty.outcome else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, "render_unavailable")

    session.renderedPreview = splitImage()
    let response = await service.handle(
      AgentRequest(id: 2, tool: "maple_render_and_inspect", arguments: ["max_edge": 256]))
    let payload = try response.outcome.get()
    XCTAssertEqual(payload.result["revision"]?.stringValue, AgentEditService.revision(of: session))
    XCTAssertEqual(payload.result["width"], 256)
    XCTAssertNotNil(payload.result["metrics"]?["near_white_fraction"])
    XCTAssertEqual(payload.image?.mimeType, "image/jpeg")
    XCTAssertEqual(payload.image?.data.prefix(2), Data([0xFF, 0xD8]))
  }
}
