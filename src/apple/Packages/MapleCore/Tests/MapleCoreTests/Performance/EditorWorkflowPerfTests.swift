import CoreImage
import Foundation
import QuartzCore
import XCTest

@testable import MapleCore

#if os(macOS)
  import AppKit
#endif

/// Production EditSession → RenderActor → GpuLiveDriver measurement. This
/// captures model-input to publish acknowledgement, NOT compositor scanout or
/// SwiftUI gesture dispatch. Pair with the app Instruments trace for that end.
@MainActor
final class EditorWorkflowPerfTests: XCTestCase {
  func testRAWOpenAndContinuousDevelopAt60Hz() async throws {
    guard ProcessInfo.processInfo.environment["MAPLE_PERF"] == "1" else {
      throw XCTSkip("Set MAPLE_PERF=1 to run the real RAW editor workflow benchmark")
    }
    guard let source = SliderTickPerfHarness.resolveFixture() else {
      throw XCTSkip("Reference RAW not installed")
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    // Every edit/sidecar/derived cache belongs to this isolated copy.
    let staged = directory.appendingPathComponent(source.lastPathComponent)
    try FileManager.default.copyItem(at: source.resolvingSymlinksInPath(), to: staged)
    let session = EditSession(asset: AssetRef(url: staged))
    let layer = CAMetalLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 1920, height: 1280)
    #if os(macOS)
      // An unattached layer can stall drawable acquisition and does not measure
      // the production compositor path. Keep a real visible surface for the run.
      let window = makeWindow(layer: layer)
    #endif
    addTeardownBlock { @MainActor in
      // Join admission before cancellation, so a queued forwarding task cannot
      // schedule new work after cleanup. XCTest awaits this block before the
      // earlier directory-removal block, including when a measurement throws.
      _ = await session.latestRenderSchedule?.value
      await session.renderActor.finishBenchmarkWork()
      let persist = session.previewPersistTask
      persist?.cancel()
      await persist?.value
      await session.flushPendingSidecarWrite()
      await session.gpuLiveDriver?.closeSession()
      #if os(macOS)
        window.orderOut(nil)
      #endif
      withExtendedLifetime(layer) {}
    }
    let driver = try XCTUnwrap(session.gpuLiveDriver, "Benchmark requires the live GPU path")
    driver.register(layer: layer)
    session.previewSize = CGSize(width: 1920, height: 1280)
    session.pixelScale = 0
    let opened = ContinuousClock.now
    await session.loadSidecar()
    session.ensureRenderStarted()
    var firstSeedMs: Double?
    var firstGPUMs: Double?
    try await waitUntil(timeout: .seconds(120)) {
      if let error = session.renderError { throw error }
      if session.renderedPreview != nil, firstSeedMs == nil {
        firstSeedMs = Self.ms(opened.duration(to: .now))
      }
      if session.gpuFramePresented, firstGPUMs == nil {
        firstGPUMs = Self.ms(opened.duration(to: .now))
      }
      return session.gpuFramePresented && !session.isResolvingFirstFrame
        && !session.isFullQualityDecoding
    }
    let fullMs = Self.ms(opened.duration(to: .now))
    try await Task.sleep(for: .milliseconds(500))
    let beforeReopen = await session.renderActor._testDecodeGeneration()
    let revisit = ContinuousClock.now
    session.ensureRenderStarted()
    await session.renderActor.awaitCurrentRenderIfInFlight()
    let afterReopen = await session.renderActor._testDecodeGeneration()
    XCTAssertEqual(beforeReopen, afterReopen, "Same-session revisit must reuse the decode")
    report([
      "case": "open", "fixture": source.lastPathComponent,
      "firstCPUPreviewMs": firstSeedMs ?? -1, "firstGPUSubmissionAckMs": firstGPUMs ?? -1,
      "firstInteractiveDevelopAckMs": fullMs,
      "sameSessionEnsureStartedNoopMs": Self.ms(revisit.duration(to: .now)),
      "viewport": "1920x1280", "profile": String(describing: session.model.profile),
    ])
    let changes: [(String, (inout AdjustmentModel, Double) -> Void)] = [
      ("exposure", { $0.exposure = -1 + $1 * 2 }),
      ("whiteBalance", { $0.temperature = 4500 + $1 * 3000 }),
      ("tone", { $0.contrast = -20 + $1 * 40 }),
      (
        "curves",
        { model, t in
          model.toneCurveLuma = ToneCurve(points: [
            ToneCurvePoint(x: 0, y: 0), ToneCurvePoint(x: 0.5, y: 0.35 + t * 0.3),
            ToneCurvePoint(x: 1, y: 1),
          ])
        }
      ),
    ]
    for (name, change) in changes {
      try await measureDrag(name: name, session: session, change: change)
    }
    // Explicit attribution control, separate from the default-quality results.
    // Never use this arm as the product's 60 Hz acceptance measurement.
    session.model.nrColor = 0
    session.model.nrLuminance = 0
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    try await Task.sleep(for: .milliseconds(500))
    try await measureDrag(
      name: "exposure-NR-disabled-attribution-only", session: session,
      change: { $0.exposure = -1 + $1 * 2 })
  }

  private func measureDrag(
    name: String, session: EditSession,
    change: (inout AdjustmentModel, Double) -> Void
  ) async throws {
    let count = 60
    let baseline = session.model
    let observations = Publications()
    var inputTimes: [UInt64: ContinuousClock.Instant] = [:]
    var inputs: [ContinuousClock.Instant] = []
    var admissions: [(Task<UInt64, Never>, ContinuousClock.Instant)] = []
    let monitor = Task { @MainActor in
      var last = session.lastPublishedRenderGeneration
      while !Task.isCancelled {
        if let gen = session.lastPublishedRenderGeneration, gen != last {
          observations.times[gen] = .now
          last = gen
        }
        try? await Task.sleep(for: .milliseconds(1))
      }
    }
    session.beginEdit(description: "Performance \(name)")
    defer {
      monitor.cancel()
      session.endEdit()
    }
    let decodeBefore = await session.renderActor._testDecodeGeneration()
    let interval = Duration.nanoseconds(16_666_667)
    var nextInput = ContinuousClock.now
    for index in 0..<count {
      let input = ContinuousClock.now
      inputs.append(input)
      var value = baseline
      change(&value, Double(index + 1) / Double(count))
      XCTAssertNotEqual(session.model, value, "Every measured input must change the model")
      session.model = value
      // Capture the existing task synchronously, before any suspension. Its
      // returned generation belongs to this input; Task.yield/currentGeneration
      // is not an ordering barrier and can silently attribute an older frame.
      let scheduled = try XCTUnwrap(session.latestRenderSchedule)
      admissions.append((scheduled, input))
      // Keep small timer oversleeps from accumulating into a lower input rate.
      // Reset overdue schedules instead of replaying their missed inputs.
      // Like a real gesture, delivery never waits for render-actor admission.
      let planned = nextInput.advanced(by: interval)
      let now = ContinuousClock.now
      nextInput = planned > now ? planned : now.advanced(by: interval)
      try await ContinuousClock().sleep(until: nextInput)
    }
    var finalGeneration: UInt64?
    for (scheduled, input) in admissions {
      let gen = await scheduled.value
      XCTAssertNil(inputTimes[gen], "A generation cannot represent two timed inputs")
      inputTimes[gen] = input
      finalGeneration = max(finalGeneration ?? gen, gen)
    }
    let final = try XCTUnwrap(finalGeneration)
    let admitted = await session.renderActor.currentGeneration()
    XCTAssertEqual(
      final, admitted, "All measured scheduling tasks must be admitted before the tail")
    try await waitUntil(timeout: .seconds(10)) {
      session.lastPublishedRenderGeneration == final
    }
    try await Task.sleep(for: .milliseconds(5))
    monitor.cancel()
    await monitor.value
    let decodeAfter = await session.renderActor._testDecodeGeneration()
    XCTAssertEqual(decodeBefore, decodeAfter, "\(name) must reuse the decoded RAW")
    XCTAssertFalse(session.gpuPresentFailed)
    let samples = observations.times.compactMap { gen, instant -> Double? in
      guard let input = inputTimes[gen], instant >= input else { return nil }
      return Self.ms(input.duration(to: instant))
    }.sorted()
    XCTAssertFalse(samples.isEmpty, "Dragging must publish changed frames")
    guard !samples.isEmpty else { return }
    let intervals = zip(inputs, inputs.dropFirst()).map { Self.ms($0.duration(to: $1)) }.sorted()
    let inputSpanMs = Self.ms(inputs.first!.duration(to: inputs.last!))
    report([
      "case": name, "inputs": count, "published": samples.count,
      "p50Ms": samples[samples.count / 2],
      "p95Ms": samples[min(samples.count - 1, Int(Double(samples.count) * 0.95))],
      "maxMs": samples.last!, "over16ms": samples.filter { $0 > 16 }.count,
      "missedOrCoalesced": count - samples.count,
      "inputSpanMs": inputSpanMs, "deliveredInputHz": Double(count - 1) * 1000 / inputSpanMs,
      "inputIntervalP50Ms": intervals[intervals.count / 2],
      "inputIntervalP95Ms": intervals[Int(Double(intervals.count) * 0.95)],
      "inputIntervalMaxMs": intervals.last!,
      "inputIntervalsOver17ms": intervals.filter { $0 > 17 }.count,
    ])
    // Correctness gates are deterministic. The report exposes the strict
    // 16ms target and missed inputs instead of disguising failures as a loose
    // average; device scanout and gesture latency need the Instruments run.
    try await Task.sleep(for: .milliseconds(250))
  }

  private func waitUntil(timeout: Duration, condition: () throws -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while try !condition() {
      if ContinuousClock.now >= deadline {
        XCTFail("Timed out waiting for a published editor frame")
        throw RenderError.pipelineFailed
      }
      try await Task.sleep(for: .milliseconds(2))
    }
  }

  private static func ms(_ duration: Duration) -> Double {
    Double(duration.components.seconds) * 1000
      + Double(duration.components.attoseconds) / 1e15
  }

  private func report(_ values: [String: Any]) {
    let bytes = try! JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
    print("MAPLE_WORKFLOW_PERF \(String(decoding: bytes, as: UTF8.self))")
  }

  #if os(macOS)
    private func makeWindow(layer: CAMetalLayer) -> NSWindow {
      _ = NSApplication.shared
      let window = NSWindow(
        contentRect: CGRect(x: 80, y: 80, width: 960, height: 640),
        styleMask: [.titled], backing: .buffered, defer: false)
      window.title = "Maple RAW performance measurement"
      let view = NSView(frame: CGRect(x: 0, y: 0, width: 960, height: 640))
      view.wantsLayer = true
      view.layer = layer
      window.contentView = view
      window.orderFrontRegardless()
      return window
    }
  #endif
}

@MainActor
private final class Publications {
  var times: [UInt64: ContinuousClock.Instant] = [:]
}

extension RenderActor {
  fileprivate func finishBenchmarkWork() async {
    let fast = renderTask
    let refine = refineTask
    let decode = decodeTask
    cancelAll()
    await fast?.value
    await refine?.value
    _ = await decode?.value
  }
}
