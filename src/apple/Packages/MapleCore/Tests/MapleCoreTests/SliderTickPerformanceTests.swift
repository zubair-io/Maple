// SliderTickPerformanceTests.swift — the editor's slider tick on the live GPU
// path, measured without UI automation (performance audit A15).
//
// Opt-in: MAPLE_PERF_SLIDER_RAW=<path to a RAW copy> swift test -c release
// --filter SliderTickPerformanceTests. `src/scripts/measure_slider_tick.sh`
// runs it on throw-away copies of the fixtures and judges the numbers.
//
// A real `EditSession` opens the RAW the way the editor does: the decode, the
// viewport-sized fast phase, the upload, the Auto profile fit and any refine
// all run through the production scheduler, onto an offscreen `CAMetalLayer`.
// Once that has settled, each tick is one `GpuLiveDriver.present` with a model
// whose single slider moved, which is the call `presentViaGpuLive` makes on a
// slider change. Ticks start on a 60 Hz cadence, as a drag delivers them, so a
// GPU slower than the cadence shows up as a growing backlog rather than as
// drawable back-pressure folded into the submit times. The chain renders at the
// fit size (about the viewport; the printed width and height), not the full RAW.
//
// The timed interval runs from entering `present` to its return: the hop onto
// the GPU session, building the render parameters, reserving a drawable, encoding
// and submitting the chain and queueing the present. It leaves out the SwiftUI
// binding and gesture, the render scheduler's actor hops and generation checks
// before the driver, the per-tick steps `presentViaGpuLive` adds around the call
// (Auto profile fit, film LUT sync, mask remap, scope readback, which is off here),
// and GPU completion (the native side submits and returns).
// `gpu_frame_ms` is one blocking render of the last tick's frame once the GPU is
// idle, with the present's white balance, input shape and anchor: the chain, a
// CPU readback and its buffer, so an upper bound on one frame's GPU work, one
// sample per series. `backlog_ms` is the same render issued straight after the
// burst minus `gpu_frame_ms`: how long the session stayed busy after the last
// submit returned. It includes waiting for queued presents to reach the display,
// so it can exceed one frame of GPU work; it is not gated.

import CoreGraphics
import Foundation
import Metal
import QuartzCore
import XCTest

@testable import MapleCore

@MainActor
final class SliderTickPerformanceTests: XCTestCase {
  private static let ticks = 60
  private static let warmUpPresents = 5
  private static let tickInterval: Duration = .microseconds(16_667)
  private static let viewport = CGSize(width: 2560, height: 1600)

  private struct Series {
    let name: String
    let sweep: (Int, inout AdjustmentModel) -> Void
  }

  private static let seriesList: [Series] = [
    Series(name: "exposure") { tick, model in model.exposure = sweepValue(tick, amplitude: 2) },
    Series(name: "highlights") { tick, model in
      model.highlights = sweepValue(tick, amplitude: 100)
    },
    Series(name: "texture") { tick, model in model.texture = sweepValue(tick, amplitude: 100) },
  ]

  private static func sweepValue(_ tick: Int, amplitude: Double) -> Double {
    amplitude * sin(Double(tick + 1) * 0.37)
  }

  func testSliderTickOnTheLiveGpuPath() async throws {
    guard let path = ProcessInfo.processInfo.environment["MAPLE_PERF_SLIDER_RAW"], !path.isEmpty
    else {
      throw XCTSkip("slider tick measurement — set MAPLE_PERF_SLIDER_RAW to a RAW file")
    }
    try XCTSkipUnless(GpuLiveFlag.isEnabled, "MAPLE_GPU_LIVE=0 turns the live GPU path off")
    let source = URL(fileURLWithPath: path)
    try XCTSkipUnless(FileManager.default.fileExists(atPath: source.path), "no file at \(path)")

    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-slider-tick-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let copy = directory.appendingPathComponent(source.lastPathComponent)
    try FileManager.default.copyItem(at: source.resolvingSymlinksInPath(), to: copy)

    let session = EditSession(asset: AssetRef(url: copy))
    addTeardownBlock {
      await session.renderActor.cancelAll()
      await session.releaseTransientMemory()
    }
    let driver = try XCTUnwrap(session.gpuLiveDriver)

    let layer = CAMetalLayer()
    layer.device = MTLCreateSystemDefaultDevice()
    layer.pixelFormat = .bgra8Unorm
    layer.framebufferOnly = true
    layer.drawableSize = Self.viewport
    driver.register(layer: layer)

    await session.loadSidecar()
    session.pixelScale = 0
    session.previewSize = Self.viewport
    session.ensureRenderStarted()
    try await waitForSettledEditor(session: session, driver: driver)

    let dims = try XCTUnwrap(driver.currentDims)
    let anchor = session.wbDeltaAnchor
    let base = session.renderModel
    let present = { (model: AdjustmentModel) async -> Bool in
      await driver.present(
        model: model, asShotCCT: anchor?.temperature, asShotTint: anchor?.tint
      ) { error in XCTFail("present threw: \(error)") }
    }

    let warmUpModels =
      [base]
      + Self.seriesList.map { series in
        var model = base
        series.sweep(0, &model)
        return model
      }
    for model in warmUpModels {
      for _ in 0..<Self.warmUpPresents {
        let presented = await present(model)
        XCTAssertTrue(presented, "warm-up present")
      }
    }
    _ = try await blockingRenderMs(driver: driver, model: base, anchor: anchor)

    for series in Self.seriesList {
      var samples = [Double]()
      let firstTick = ContinuousClock.now
      for tick in 0..<Self.ticks {
        var model = base
        series.sweep(tick, &model)
        try await Task.sleep(until: firstTick + Self.tickInterval * tick, clock: .continuous)
        let started = ContinuousClock.now
        let presented = await present(model)
        samples.append(started.duration(to: .now).milliseconds)
        XCTAssertTrue(presented, "\(series.name) tick \(tick) did not present a current frame")
      }
      var last = base
      series.sweep(Self.ticks - 1, &last)
      let busyReadbackMs = try await blockingRenderMs(driver: driver, model: last, anchor: anchor)
      let idleReadbackMs = try await blockingRenderMs(driver: driver, model: last, anchor: anchor)
      print(
        Self.line(
          series: series.name, dims: dims, samples: samples, gpuFrameMs: idleReadbackMs,
          backlogMs: max(0, busyReadbackMs - idleReadbackMs)))
    }
  }

  private func waitForSettledEditor(session: EditSession, driver: GpuLiveDriver) async throws {
    let deadline = ContinuousClock.now + .seconds(240)
    var quietSince: ContinuousClock.Instant?
    while ContinuousClock.now < deadline {
      let busy = session.isRendering || session.isFullQualityDecoding || !driver.hasSession
      quietSince = busy ? nil : (quietSince ?? .now)
      if let quietSince, quietSince.duration(to: .now) >= .seconds(3) { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTFail("the editor did not open the live GPU session and settle within 240 s")
  }

  private func blockingRenderMs(
    driver: GpuLiveDriver, model: AdjustmentModel, anchor: ImageEditPipeline.AsShotWB?
  ) async throws -> Double {
    let started = ContinuousClock.now
    let frame = await driver.renderCurrentFrameBytes(
      model: model, asShotCCT: anchor?.temperature, asShotTint: anchor?.tint)
    _ = try XCTUnwrap(frame, "the blocking render returned no frame")
    return started.duration(to: .now).milliseconds
  }

  private static func line(
    series: String, dims: (width: Int, height: Int), samples: [Double], gpuFrameMs: Double,
    backlogMs: Double
  ) -> String {
    let sorted = samples.sorted()
    let median = (sorted[(sorted.count - 1) / 2] + sorted[sorted.count / 2]) / 2
    let p95 = sorted[Int((Double(sorted.count) * 0.95).rounded(.up)) - 1]
    return "SLIDER_TICK series=\(series) width=\(dims.width) height=\(dims.height) "
      + "ticks=\(samples.count) min_ms=\(format(sorted[0])) median_ms=\(format(median)) "
      + "p95_ms=\(format(p95)) max_ms=\(format(sorted[sorted.count - 1])) "
      + "gpu_frame_ms=\(format(gpuFrameMs)) backlog_ms=\(format(backlogMs))"
  }

  private static func format(_ value: Double) -> String { String(format: "%.2f", value) }
}

extension Duration {
  fileprivate var milliseconds: Double {
    Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15
  }
}
