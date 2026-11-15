import CoreGraphics
import Foundation
import RawPipeline
import XCTest

@testable import MapleCore

final class PanoSeamExecutionTests: XCTestCase {
  private var request: SeamConstraintsRequest {
    SeamConstraintsRequest(
      canvas: .init(width: 800, height: 400),
      regions: [
        .init(frame: 1, kind: .include, rect: .init(x: 100, y: 30, width: 20, height: 40))
      ])
  }

  func testLocalRequestPreservesReferenceCanvasAndRegion() throws {
    let options = PanoOptions(seamConstraints: request)
    let json = try XCTUnwrap(PanoFFICall.seamConstraintsJSON(options, frameCount: 2))
    XCTAssertEqual(
      try JSONDecoder().decode(SeamConstraintsRequest.self, from: Data(json.utf8)), request)
    XCTAssertNil(try PanoFFICall.seamConstraintsJSON(.default, frameCount: 2))
    XCTAssertEqual(options.withoutEdges, .default)
  }

  func testTileRejectsIntentBeforeDecode() {
    XCTAssertThrowsError(
      try PanoFFICall.seamConstraintsJSON(
        PanoOptions(strategy: .tile, seamConstraints: request), frameCount: 2)
    ) {
      XCTAssertTrue($0.localizedDescription.contains("invalid_seam_constraints"))
    }
  }

  func testNativeConstrainedEntryRejectsInvalidVersionBeforeOpeningInputs() {
    let json = #"{"version":2,"canvas":{"width":800,"height":400},"regions":[]}"#
    let code = "/missing/a.dng".withCString { first in
      "/missing/b.dng".withCString { second in
        "/missing/out.png".withCString { output in
          json.withCString { constraints in
            let paths: [UnsafePointer<CChar>?] = [first, second]
            return paths.withUnsafeBufferPointer {
              maple_pano_stitch_constrained(
                $0.baseAddress, 2, output, nil, 0, MaplePanoEdges(), nil,
                Keep, Mesh, Auto, Classical, constraints, nil, nil, nil)
            }
          }
        }
      }
    }
    XCTAssertEqual(code, -11)
    XCTAssertTrue(String(cString: maple_last_error()).contains("invalid_seam_constraints"))
  }

  func testNativeConstrainedProxyPreviewRejectsIntentBeforeOpeningInputs() {
    let json = #"{"version":2,"canvas":{"width":800,"height":400},"regions":[]}"#
    let code = "/missing/a.dng".withCString { first in
      "/missing/b.dng".withCString { second in
        "/missing/preview.png".withCString { output in
          json.withCString { constraints in
            let paths: [UnsafePointer<CChar>?] = [first, second]
            return paths.withUnsafeBufferPointer {
              maple_pano_preview_constrained(
                $0.baseAddress, 2, output, nil, nil, nil, MaplePanoEdges(), nil,
                Keep, Mesh, Auto, Classical, constraints, nil, nil, nil)
            }
          }
        }
      }
    }
    XCTAssertEqual(code, -11)
    XCTAssertTrue(String(cString: maple_last_error()).contains("invalid_seam_constraints"))
  }

  func testSourcePickerMatchesLocalExecutionOrder() {
    let local = ["b.dng", "a.dng"].map { AssetRef(url: URL(fileURLWithPath: "/tmp/\($0)")) }
    XCTAssertEqual(
      PanoSourceOrder.frames(local).compactMap {
        $0.primaryURL?.lastPathComponent
      },
      ["a.dng", "b.dng"])
  }
}

@MainActor
final class PanoSeamSessionTests: XCTestCase {
  private func settle(_ session: PanoMergeSession) async {
    let deadline = ContinuousClock.now + .seconds(3)
    while session.isPreviewing, ContinuousClock.now < deadline {
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertFalse(session.isPreviewing)
  }

  func testDraftRequiresExplicitPreviewAndReusesAlignmentThenResubmits() async throws {
    let stitcher = SeamRecordingStitcher()
    let session = PanoMergeSession(
      stitcher: stitcher, availableMemory: { nil }, freeSpace: { _, _ in nil })
    let assets = [AssetRef.preview(displayName: "a.dng"), AssetRef.preview(displayName: "b.dng")]
    session.preview(assets: assets)
    await settle(session)
    let request = SeamConstraintsRequest(
      canvas: .init(width: 8, height: 4),
      regions: [
        .init(frame: 1, kind: .exclude, rect: .init(x: 0, y: 0, width: 2, height: 2))
      ])
    session.setSeamConstraints(request)
    XCTAssertEqual(stitcher.previewOptions.count, 1)
    session.previewSeamConstraints()
    await settle(session)
    XCTAssertEqual(stitcher.previewOptions.last?.seamConstraints, request)
    XCTAssertEqual(stitcher.offeredAlignments.last!, session.alignment)
    session.start(assets: assets)
    let deadline = ContinuousClock.now + .seconds(3)
    while session.isRunning, ContinuousClock.now < deadline { await Task.yield() }
    XCTAssertEqual(stitcher.stitchOptions?.seamConstraints, request)
    session.reset()
    session.setSeamConstraints(nil)
    session.previewSeamConstraints()
    await settle(session)
    XCTAssertNil(stitcher.previewOptions.last?.seamConstraints)
  }

  func testGeometryChangeInvalidatesDraftAndStalePreviewIsNotAccepted() async {
    let stitcher = SeamRecordingStitcher()
    let session = PanoMergeSession(
      stitcher: stitcher, previewDebounce: .zero,
      availableMemory: { nil }, freeSpace: { _, _ in nil })
    let assets = [AssetRef.preview(displayName: "a"), AssetRef.preview(displayName: "b")]
    session.preview(assets: assets)
    await settle(session)
    let request = SeamConstraintsRequest(canvas: .init(width: 8, height: 4), regions: [])
    session.setSeamConstraints(request)
    session.options.retention = .strict
    XCTAssertNil(session.options.seamConstraints)
    XCTAssertFalse(session.seamAuthoringAvailable)
    await settle(session)
    session.setSeamConstraints(request)
    stitcher.stale = true
    session.previewSeamConstraints()
    await settle(session)
    XCTAssertNil(session.options.seamConstraints)
    guard case .failed(let error) = session.previewState else {
      return XCTFail("Expected stale geometry failure")
    }
    XCTAssertTrue(error.message.contains("invalid_seam_constraints"))
    XCTAssertFalse(session.seamAuthoringAvailable)
  }
}

@MainActor
private final class SeamRecordingStitcher: PanoStitching, @unchecked Sendable {
  var previewOptions: [PanoOptions] = []
  var offeredAlignments: [PanoAlignment?] = []
  var stitchOptions: PanoOptions?
  var stale = false
  nonisolated func cancel() {}

  func preview(
    assets: [AssetRef], options: PanoOptions, alignment: PanoAlignment?,
    progress: @escaping @MainActor (PanoStage, Double) -> Void
  ) async throws -> PanoPreview {
    previewOptions.append(options)
    offeredAlignments.append(alignment)
    let context = CGContext(
      data: nil, width: 8, height: 4, bitsPerComponent: 8, bytesPerRow: 32,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return PanoPreview(
      image: context.makeImage()!, alignment: PanoAlignment(json: Data("{}".utf8)),
      alignmentOutcome: stale ? .stale(reason: "changed") : alignment == nil ? .solved : .reused)
  }

  func stitch(
    assets: [AssetRef], options: PanoOptions, alignment: PanoAlignment?, maxCanvasPixels: Int?,
    progress: @escaping @MainActor (PanoStage, Double) -> Void
  ) async throws -> PanoResult {
    stitchOptions = options
    return PanoResult(outputURL: URL(fileURLWithPath: "/tmp/pano.png"), reportSummary: "done")
  }
}
