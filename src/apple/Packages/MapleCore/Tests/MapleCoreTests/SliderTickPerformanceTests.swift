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
// slider change.
//
// The timed interval runs from entering `present` to its return: the hop onto
// the GPU session, building the render parameters, reserving a drawable, encoding
// and submitting the chain and queueing the present. It leaves out the SwiftUI
// binding and gesture, the render scheduler's actor hops and generation checks
// before the driver, and GPU completion (the native side submits and returns).
// `backlog_ms` reports what the GPU still had queued after the last tick: a
// blocking render of the same frame after the burst, minus the same render when
// idle. Near zero means the submit times above were not hiding GPU work.

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
    try FileManager.default.copyItem(at: source, to: copy)

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

    for _ in 0..<Self.warmUpPresents {
      let presented = await present(base)
      XCTAssertTrue(presented, "warm-up present")
    }

    let idleReadbackMs = try await blockingRenderMs(driver: driver, model: base)
    for series in Self.seriesList {
      var samples = [Double]()
      for tick in 0..<Self.ticks {
        var model = base
        series.sweep(tick, &model)
        let started = ContinuousClock.now
        let presented = await present(model)
        samples.append(started.duration(to: .now).milliseconds)
        XCTAssertTrue(presented, "\(series.name) tick \(tick) did not present a current frame")
      }
      var last = base
      series.sweep(Self.ticks - 1, &last)
      let busyReadbackMs = try await blockingRenderMs(driver: driver, model: last)
      let backlogMs = max(0, busyReadbackMs - idleReadbackMs)
      print(Self.line(series: series.name, dims: dims, samples: samples, backlogMs: backlogMs))
    }
  }

  private func waitForSettledEditor(session: EditSession, driver: GpuLiveDriver) async throws {
    let deadline = ContinuousClock.now + .seconds(240)
    var quietSince: ContinuousClock.Instant?
    while ContinuousClock.now < deadline {
      let busy = session.isRendering || !driver.hasSession
      quietSince = busy ? nil : (quietSince ?? .now)
      if let quietSince, quietSince.duration(to: .now) >= .seconds(3) { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTFail("the editor did not open the live GPU session and settle within 240 s")
  }

  private func blockingRenderMs(driver: GpuLiveDriver, model: AdjustmentModel) async throws
    -> Double
  {
    let session = try XCTUnwrap(driver.session)
    let started = ContinuousClock.now
    _ = try await session.renderToBuffer(model: model, targetColorSpace: .srgb)
    return started.duration(to: .now).milliseconds
  }

  private static func line(
    series: String, dims: (width: Int, height: Int), samples: [Double], backlogMs: Double
  ) -> String {
    let sorted = samples.sorted()
    let median = (sorted[(sorted.count - 1) / 2] + sorted[sorted.count / 2]) / 2
    let p95 = sorted[Int((Double(sorted.count) * 0.95).rounded(.up)) - 1]
    return "SLIDER_TICK series=\(series) width=\(dims.width) height=\(dims.height) "
      + "ticks=\(samples.count) min_ms=\(format(sorted[0])) median_ms=\(format(median)) "
      + "p95_ms=\(format(p95)) max_ms=\(format(sorted[sorted.count - 1])) "
      + "backlog_ms=\(format(backlogMs))"
  }

  private static func format(_ value: Double) -> String { String(format: "%.2f", value) }
}

extension Duration {
  fileprivate var milliseconds: Double {
    Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15
  }
}
