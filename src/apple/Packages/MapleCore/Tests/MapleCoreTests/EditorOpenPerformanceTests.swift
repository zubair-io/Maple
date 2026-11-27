// EditorOpenPerformanceTests.swift — what opening a photo in the editor costs,
// measured without UI automation (performance audit A14).
//
// Opt-in: MAPLE_PERF_EDITOR_RAW=<path to a RAW> [MAPLE_PERF_EDITOR_RUNS=5]
// swift test -c release --filter EditorOpenPerformanceTests. Each run opens a
// fresh clone of the RAW in a temporary folder through a real `EditSession`
// the way the editor does: the canvas's viewport and Metal layer, then
// `loadSidecar()`, `ensureRenderStarted()` and `kickRenderAfterGpuCanvasMount()`.
//
// One `EDITOR_OPEN` line per run: when the first picture reached the screen
// (`first_preview_ms`, from the first seed or GPU frame), when the first GPU
// frame was presented, when the last render of the open finished
// (`settled_ms`), plus counts read from existing state: render schedules
// (`render_schedules`, the scheduler's generation), decoded-cache writes
// (`cache_writes`, seeds included) and the distinct temporary XMP files that
// appeared in the temporary folder while the open ran (`temp_xmp_files`, polled
// every few ms; approximate: a file that lives for less than a poll is missed,
// and another process writing the same kind of file is counted). Run 1 is the
// cold open; later runs reuse the process's warm shader and page caches. The
// clock starts when the canvas registers its layer, the first step of an open.
// The test fails if no picture appears or the open does not settle in time.

import CoreGraphics
import Foundation
import Metal
import QuartzCore
import XCTest

@testable import MapleCore

@MainActor
final class EditorOpenPerformanceTests: XCTestCase {
  private static let viewport = CGSize(width: 2560, height: 1600)
  private static let quietWindow: Duration = .milliseconds(1500)
  private static let deadline: Duration = .seconds(240)

  private struct Run {
    var firstSeedMs: Double?
    var firstGpuFrameMs: Double?
    var settledMs = 0.0
    var refinePhaseSeen = false
    var renderSchedules: UInt64 = 0
    var cacheWrites: UInt64 = 0
    var tempXMPFiles = 0
    var gpuFramePresented = false
  }

  func testEditorOpen() async throws {
    guard let path = ProcessInfo.processInfo.environment["MAPLE_PERF_EDITOR_RAW"], !path.isEmpty
    else {
      throw XCTSkip("editor open measurement — set MAPLE_PERF_EDITOR_RAW to a RAW file")
    }
    try XCTSkipUnless(GpuLiveFlag.isEnabled, "MAPLE_GPU_LIVE=0 turns the live GPU path off")
    let source = URL(fileURLWithPath: path).resolvingSymlinksInPath()
    try XCTSkipUnless(FileManager.default.fileExists(atPath: source.path), "no file at \(path)")
    let runs = Int(ProcessInfo.processInfo.environment["MAPLE_PERF_EDITOR_RUNS"] ?? "") ?? 1

    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-editor-open-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }

    for index in 1...max(1, runs) {
      let copyDirectory = directory.appendingPathComponent("run\(index)")
      try FileManager.default.createDirectory(at: copyDirectory, withIntermediateDirectories: true)
      let copy = copyDirectory.appendingPathComponent(source.lastPathComponent)
      try FileManager.default.copyItem(at: source, to: copy)
      let run = try await openOnce(copy)
      print(Self.line(name: source.lastPathComponent, run: index, result: run))
      try? FileManager.default.removeItem(at: copyDirectory)
    }
  }

  private func openOnce(_ copy: URL) async throws -> Run {
    let session = EditSession(asset: AssetRef(url: copy))
    let driver = try XCTUnwrap(session.gpuLiveDriver)
    let layer = CAMetalLayer()
    layer.device = MTLCreateSystemDefaultDevice()
    layer.pixelFormat = .bgra8Unorm
    layer.framebufferOnly = true
    layer.drawableSize = Self.viewport

    let temporaryDirectory = FileManager.default.temporaryDirectory
    let preexistingXMP = Self.strippedXMPNames(in: temporaryDirectory)
    var seenXMP = Set<String>()
    var result = Run()
    let started = ContinuousClock.now
    var lastBusy = started
    var polls = 0
    var settled = false

    driver.register(layer: layer)
    session.pixelScale = 0
    session.previewSize = Self.viewport

    await session.loadSidecar()
    session.ensureRenderStarted()
    session.kickRenderAfterGpuCanvasMount()

    let limit = started + Self.deadline
    while ContinuousClock.now < limit {
      let now = ContinuousClock.now
      let elapsed = started.duration(to: now).milliseconds
      let painted = session.renderedPreview != nil || session.gpuFramePresented
      if session.renderedPreview != nil, result.firstSeedMs == nil { result.firstSeedMs = elapsed }
      if session.gpuFramePresented, result.firstGpuFrameMs == nil {
        result.firstGpuFrameMs = elapsed
      }
      if session.renderPhase == .refine, session.isRendering { result.refinePhaseSeen = true }
      let busy = session.isRendering || session.isFullQualityDecoding || !painted
      if busy { lastBusy = now }
      polls += 1
      if polls % 2 == 0 {
        seenXMP.formUnion(Self.strippedXMPNames(in: temporaryDirectory).subtracting(preexistingXMP))
      }
      if lastBusy.duration(to: now) >= Self.quietWindow {
        settled = true
        break
      }
      try await Task.sleep(for: .milliseconds(2))
    }
    result.settledMs = started.duration(to: lastBusy).milliseconds
    result.renderSchedules = await session.renderActor.currentGeneration()
    result.cacheWrites = await session.renderActor._testDecodeGeneration()
    result.tempXMPFiles = seenXMP.count
    result.gpuFramePresented = session.gpuFramePresented

    await session.renderActor.cancelAll()
    await session.releaseTransientMemory()
    XCTAssertTrue(settled, "the open did not settle within \(Self.deadline)")
    XCTAssertNotNil(result.firstSeedMs ?? result.firstGpuFrameMs, "no picture reached the screen")
    return result
  }

  private static func strippedXMPNames(in directory: URL) -> Set<String> {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    return Set(names.filter { $0.hasPrefix("maple-strip-") && $0.hasSuffix(".xmp") })
  }

  private static func line(name: String, run: Int, result: Run) -> String {
    func format(_ value: Double?) -> String { value.map { String(format: "%.1f", $0) } ?? "none" }
    let first = [result.firstSeedMs, result.firstGpuFrameMs].compactMap { $0 }.min()
    return "EDITOR_OPEN file=\(name) run=\(run) first_preview_ms=\(format(first)) "
      + "first_seed_ms=\(format(result.firstSeedMs)) "
      + "first_gpu_frame_ms=\(format(result.firstGpuFrameMs)) "
      + "settled_ms=\(format(result.settledMs)) refine_phase_seen=\(result.refinePhaseSeen) "
      + "render_schedules=\(result.renderSchedules) cache_writes=\(result.cacheWrites) "
      + "temp_xmp_files=\(result.tempXMPFiles) gpu_frame=\(result.gpuFramePresented)"
  }
}

extension Duration {
  fileprivate var milliseconds: Double {
    Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15
  }
}
