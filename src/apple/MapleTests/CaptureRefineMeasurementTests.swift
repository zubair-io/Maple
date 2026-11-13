// CaptureRefineMeasurementTests.swift — the GPU capture refine's latency and
// peak footprint on the device it runs on (#5381), at this platform's
// `CaptureRefineBudget`, in the app test target so it runs on the iPhone
// simulator. Opt-in: set `MAPLE_REFINE_MEASURE=1` (from
// xcodebuild, `TEST_RUNNER_MAPLE_REFINE_MEASURE=1`) on an idle machine.

import Darwin
import Foundation
import RawPipeline
import XCTest

import MapleCore

final class CaptureRefineMeasurementTests: XCTestCase {
  /// The process footprint jetsam enforces on iOS.
  private static func footprint() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return result == KERN_SUCCESS ? info.phys_footprint : 0
  }

  /// The highest footprint sampled every millisecond while `work` runs.
  private func peakFootprint<T>(_ work: () throws -> T) rethrows -> (T, UInt64) {
    let peak = Peak(Self.footprint())
    let sampler = Thread {
      while !Thread.current.isCancelled {
        peak.record(Self.footprint())
        usleep(1000)
      }
    }
    sampler.start()
    defer { sampler.cancel() }
    let result = try work()
    peak.record(Self.footprint())
    return (result, peak.value)
  }

  func testRefineLatencyAndPeakFootprint() throws {
    guard ProcessInfo.processInfo.environment["MAPLE_REFINE_MEASURE"] == "1" else {
      throw XCTSkip("set MAPLE_REFINE_MEASURE=1 to measure the capture refine")
    }
    let raw = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("test-fixtures/raws/test_0007.DNG")
    guard FileManager.default.fileExists(atPath: raw.path) else {
      throw XCTSkip("RAW fixture missing: \(raw.path)")
    }
    let budget = CaptureRefineBudget.current
    // As the editor does: the decode bakes the stripped live model.
    let plain = try XCTUnwrap(RawCoreBridge.writeStrippedModelXMP(AdjustmentModel()))
    defer { try? FileManager.default.removeItem(at: plain) }
    let decoded = try PipelineRenderer.renderSceneLinearSized(
      rawPath: raw, xmpPath: plain, maxLongEdge: budget.max_long_edge)
    let base = try XCTUnwrap(decoded.captureBase)
    // The simulator's Metal device has no indirect dispatch, which BM3D
    // needs, so there the refine runs chroma prefilter and sharpening only.
    #if targetEnvironment(simulator)
      let denoise = (0.0, 0.0)
    #else
      let denoise = (50.0, 30.0)
    #endif
    let sidecars = try [(60.0, denoise.0, 80.0), (40.0, denoise.1, 60.0)].map { values in
      var model = AdjustmentModel()
      (model.chromaPrefilter, model.deepDenoise, model.captureSharpeningAmount) = values
      return try XCTUnwrap(RawCoreBridge.writeStrippedModelXMP(model))
    }
    defer { sidecars.forEach { try? FileManager.default.removeItem(at: $0) } }
    let measured = try (0..<12).map { tick -> (ms: Double, rise: UInt64) in
      let before = Self.footprint()
      let started = Date()
      let (refined, peak) = try peakFootprint {
        try PipelineRenderer.refineCapture(base: base, xmpPath: sidecars[tick % 2])
      }
      XCTAssertNotNil(refined)
      return (Date().timeIntervalSince(started) * 1000, peak.saturatingSubtract(before))
    }.dropFirst(2)
    let times = measured.map(\.ms).sorted()
    let rise = measured.map(\.rise).max() ?? 0
    let report =
      "capture refine \(decoded.width)x\(decoded.height) cap=\(budget.bm3d_binding_cap_bytes >> 20)MiB:"
      + " p50=\(times[times.count / 2])ms p95=\(times[times.count * 95 / 100])ms"
      + " footprint rise=\(Double(rise) / 1_048_576)MiB"
    print(report)
    // A hosted test's stdout is the app's, which xcodebuild does not show.
    let attachment = XCTAttachment(string: report)
    attachment.name = "capture-refine-measurement"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}

private final class Peak: @unchecked Sendable {
  private let lock = NSLock()
  private var highest: UInt64

  init(_ start: UInt64) { highest = start }

  func record(_ sample: UInt64) {
    lock.lock()
    highest = max(highest, sample)
    lock.unlock()
  }

  var value: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return highest
  }
}

extension UInt64 {
  fileprivate func saturatingSubtract(_ other: UInt64) -> UInt64 {
    self > other ? self - other : 0
  }
}
