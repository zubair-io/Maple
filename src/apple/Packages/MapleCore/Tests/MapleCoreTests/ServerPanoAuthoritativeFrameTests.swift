import CoreGraphics
import Foundation
import ImageIO
import MapleCloudKit
import XCTest

@testable import MapleCore

final class ServerPanoAuthoritativeFrameTests: XCTestCase {
  private let constraints = SeamConstraintsRequest(
    canvas: .init(width: 2048, height: 1024),
    regions: [.init(frame: 1, kind: .include, rect: .init(x: 10, y: 20, width: 30, height: 40))])

  func testPreviewJobDecodesAuthoritativeFramesWithoutSortingAndAllowsOldServers() throws {
    let decoded = try previewJob(
      framesJSON: """
        [{"assetId":"second-primary","path":"/real/z.dng"},
         {"assetId":"first-primary","path":"/real/a.dng"}]
        """)
    let sources = try XCTUnwrap(decoded.result?.frames)
    XCTAssertEqual(sources.map(\.assetId), ["second-primary", "first-primary"])
    XCTAssertEqual(sources.map(\.path), ["/real/z.dng", "/real/a.dng"])
    XCTAssertEqual(sources.map(\.id), sources.map(\.assetId))
    XCTAssertEqual(
      try JSONDecoder().decode(
        [PanoSourceFrame].self, from: JSONEncoder().encode(sources)), sources)
    XCTAssertNil(try previewJob(framesJSON: nil).result?.frames)
    XCTAssertNil(PanoServerJob.Result().frames)
  }

  private var previewPNG: Data {
    let context = CGContext(
      data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let bytes = NSMutableData()
    let destination = CGImageDestinationCreateWithData(bytes, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    precondition(CGImageDestinationFinalize(destination))
    return bytes as Data
  }

  private func previewJob(framesJSON: String?) throws -> PanoServerJob {
    let result = framesJSON.map { #""frames":\#($0),"# } ?? ""
    return try JSONDecoder().decode(
      PanoServerJob.self,
      from: Data(
        """
        {"id":"preview-1","status":"done","progress":{"current":600,"total":600},
         "result":{\(result)"alignment":{"status":"reused"}}}
        """.utf8))
  }

  @MainActor
  private func waitForPreview(_ session: PanoMergeSession) async throws {
    for _ in 0..<200 {
      if !session.isPreviewing { return }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("Preview did not finish")
  }

  @MainActor
  func testServerPreviewUsesAuthoritativePrimaryFrameOrderNotSelectedAliases() async throws {
    let completed = try previewJob(
      framesJSON: """
        [{"assetId":"second-primary","path":"/real/z.dng"},
         {"assetId":"first-primary","path":"/real/a.dng"}]
        """)
    let jobs = FakePanoJobs([.job(completed)], previewPNG: previewPNG)
    let session = PanoMergeSession(stitcher: stitcher(jobs), previewDebounce: .zero)
    // Alias order and lexical realpath order both differ from the engine's returned order.
    session.preview(assets: [cloudFrame("a-symlink.dng"), cloudFrame("z-symlink.dng")])
    try await waitForPreview(session)
    XCTAssertEqual(
      session.seamFrames.map { String(describing: $0.id) },
      ["second-primary", "first-primary"])
    XCTAssertTrue(session.seamAuthoringAvailable)
  }

  @MainActor
  func testAuthoritativeFramesSurviveConstrainedPreviewStitchAndResubmission() async throws {
    let completed = try previewJob(
      framesJSON: """
        [{"assetId":"second-primary","path":"/real/z.dng"},
         {"assetId":"first-primary","path":"/real/a.dng"}]
        """)
    let jobs = FakePanoJobs([.job(completed), .job(completed)], previewPNG: previewPNG)
    let worker = stitcher(jobs)
    let session = PanoMergeSession(stitcher: worker, previewDebounce: .zero)
    let selected = [cloudFrame("z-alias.dng"), cloudFrame("a-alias.dng")]
    session.preview(assets: selected)
    try await waitForPreview(session)
    let authoritative = try XCTUnwrap(session.lastPreview?.sourceFrames)
    XCTAssertEqual(authoritative.map(\.path), ["/real/z.dng", "/real/a.dng"])
    XCTAssertEqual(
      session.lastPreview?.with(matcher: .used(.classical)).sourceFrames, authoritative)
    session.setSeamConstraints(constraints)
    session.previewSeamConstraints()
    try await waitForPreview(session)
    XCTAssertEqual(session.seamFrames, authoritative)
    XCTAssertEqual(jobs.previewBodies.last?.seamConstraints, constraints)
    XCTAssertEqual(jobs.previewBodies.last?.alignmentFrom, "preview-1")
    for _ in 0..<2 {
      jobs.script([job(.done, result: .init(outputAssetId: "output", outputPath: "/p.png"))])
      session.start(assets: selected)
      for _ in 0..<200 where session.isRunning {
        try await Task.sleep(for: .milliseconds(5))
      }
      XCTAssertEqual(jobs.stitchRequests.last?.seamConstraints, constraints)
      XCTAssertEqual(jobs.stitchRequests.last?.alignmentFrom, "preview-1")
      XCTAssertEqual(session.seamFrames, authoritative)
      session.reset()
    }
  }

  @MainActor
  func testMissingEmptyOrIncompleteServerFramesDisableAuthoring() async throws {
    for frameList in [nil, "[]", #"[{"assetId":"only","path":"/real/a.dng"}]"#] {
      let completed = try previewJob(framesJSON: frameList)
      let jobs = FakePanoJobs([.job(completed)], previewPNG: previewPNG)
      let session = PanoMergeSession(stitcher: stitcher(jobs), previewDebounce: .zero)
      session.preview(assets: frames)
      try await waitForPreview(session)
      XCTAssertNotNil(session.lastPreview)
      XCTAssertFalse(session.seamAuthoringAvailable)
      XCTAssertTrue(
        session.seamAuthoringDisabledReason?.contains("every preview source frame") == true)
      session.setSeamConstraints(constraints)
      XCTAssertNil(session.options.seamConstraints)
    }
  }

  @MainActor
  func testGeometryAndInputChangesInvalidateServerSeamAuthoring() async throws {
    let completed = try previewJob(
      framesJSON: """
        [{"assetId":"b","path":"/real/b.dng"},{"assetId":"a","path":"/real/a.dng"}]
        """)
    let jobs = FakePanoJobs([.job(completed)], previewPNG: previewPNG)
    let session = PanoMergeSession(stitcher: stitcher(jobs), previewDebounce: .seconds(60))
    session.preview(assets: frames)
    try await waitForPreview(session)
    session.setSeamConstraints(constraints)
    XCTAssertNotNil(session.options.seamConstraints)
    session.options.strategy = .rotation
    XCTAssertNil(session.options.seamConstraints)
    XCTAssertFalse(session.seamAuthoringAvailable)
    jobs.script([.job(completed)])
    session.preview(assets: frames)
    try await waitForPreview(session)
    session.setSeamConstraints(constraints)
    XCTAssertNotNil(session.options.seamConstraints)
    session.preview(assets: [cloudFrame("new.dng"), cloudFrame("other.dng")])
    XCTAssertNil(session.options.seamConstraints)
    XCTAssertNil(session.lastPreview)
    XCTAssertFalse(session.seamAuthoringAvailable)
    session.cancel()
  }

  @MainActor
  func testChangedAuthoritativeOrderInvalidatesConstrainedPreview() async throws {
    let first = try previewJob(
      framesJSON: """
        [{"assetId":"b","path":"/real/b.dng"},{"assetId":"a","path":"/real/a.dng"}]
        """)
    let changed = try previewJob(
      framesJSON: """
        [{"assetId":"a","path":"/real/a.dng"},{"assetId":"b","path":"/real/b.dng"}]
        """)
    let jobs = FakePanoJobs([.job(first), .job(changed)], previewPNG: previewPNG)
    let session = PanoMergeSession(stitcher: stitcher(jobs), previewDebounce: .zero)
    session.preview(assets: frames)
    try await waitForPreview(session)
    session.setSeamConstraints(constraints)
    session.previewSeamConstraints()
    try await waitForPreview(session)
    XCTAssertNil(session.options.seamConstraints)
    XCTAssertFalse(session.seamAuthoringAvailable)
    guard case .failed = session.previewState else {
      return XCTFail("Changed source indices must invalidate the constrained preview")
    }
  }

  @MainActor
  func testWaitingStitchAbortsWhenConstrainedPreviewInvalidatesItsDraft() async throws {
    let original = [
      PanoSourceFrame(assetId: "b", path: "/real/b.dng"),
      PanoSourceFrame(assetId: "a", path: "/real/a.dng"),
    ]
    let initial = PanoServerJob.Result(alignment: .init(status: "reused"), frames: original)
    let invalidated: [PanoServerJob.Result] = [
      .init(alignment: .init(status: "reused"), frames: Array(original.reversed())),
      .init(alignment: .init(status: "stale", staleReason: "changed geometry"), frames: original),
      .init(alignment: .init(status: "reused")),
    ]
    for result in invalidated {
      let jobs = FakePanoJobs([job(.done, result: initial)], previewPNG: previewPNG)
      let session = PanoMergeSession(stitcher: stitcher(jobs), previewDebounce: .zero)
      session.preview(assets: frames)
      try await waitForPreview(session)
      let acceptedAlignment = session.alignment
      session.setSeamConstraints(constraints)
      jobs.script([job(.done, result: result)])
      session.previewSeamConstraints()
      session.start(assets: frames)
      guard case .finishingAlignment = session.state else {
        return XCTFail("Create must wait for the running constrained preview")
      }
      for _ in 0..<200 where session.isRunning {
        try await Task.sleep(for: .milliseconds(5))
      }
      XCTAssertFalse(session.isRunning)
      XCTAssertNil(session.options.seamConstraints)
      XCTAssertTrue(jobs.stitchRequests.isEmpty)
      XCTAssertEqual(session.alignment, acceptedAlignment)
      XCTAssertEqual(session.lastPreview?.sourceFrames, original)
      guard case .error(let error) = session.state else {
        return XCTFail("Invalidated seam intent must fail before submitting the stitch")
      }
      XCTAssertTrue(error.message.contains("invalid_seam_constraints"))
    }
  }

  @MainActor
  func testWaitingStitchKeepsDraftWhenServerPreviewPreservesFrames() async throws {
    let completed = try previewJob(
      framesJSON: """
        [{"assetId":"b","path":"/real/b.dng"},{"assetId":"a","path":"/real/a.dng"}]
        """)
    let jobs = FakePanoJobs([.job(completed)], previewPNG: previewPNG)
    let session = PanoMergeSession(stitcher: stitcher(jobs), previewDebounce: .zero)
    session.preview(assets: frames)
    try await waitForPreview(session)
    session.setSeamConstraints(constraints)
    jobs.script([
      .job(completed),
      job(.done, result: .init(outputAssetId: "output", outputPath: "/p.png")),
    ])
    session.previewSeamConstraints()
    session.start(assets: frames)
    for _ in 0..<200 where session.isRunning {
      try await Task.sleep(for: .milliseconds(5))
    }
    guard case .done = session.state else {
      return XCTFail("An unchanged constrained preview must allow the waiting stitch")
    }
    XCTAssertEqual(jobs.stitchRequests.count, 1)
    XCTAssertEqual(jobs.stitchRequests.first?.seamConstraints, constraints)
  }
}
