import Foundation
import XCTest

@testable import MapleCore

/// Measures main-actor scheduling during the production RAW thumbnail path.
/// The UI scroll harness measures the additional SwiftUI/compositor workload.
final class BrowseThumbnailResponsivenessTests: XCTestCase {
  @MainActor
  func test250ColdRawThumbnailsLeaveMainActorResponsive() async throws {
    let repo = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    let fixture = repo.appendingPathComponent("test-fixtures/raws/test_0017.dng")
    guard FileManager.default.fileExists(atPath: fixture.path) else {
      throw XCTSkip("Requires test-fixtures/raws/test_0017.dng")
    }
    let prefix = UUID().uuidString
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(prefix)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let first = folder.appendingPathComponent("\(prefix)-0000.dng")
    try FileManager.default.copyItem(at: fixture, to: first)
    let urls = try (0..<250).map { index in
      let url = folder.appendingPathComponent(String(format: "\(prefix)-%04d.dng", index))
      if index > 0 { try FileManager.default.linkItem(at: first, to: url) }
      return url
    }
    await ThumbnailDiskCache.shared.configure(folderURL: folder)
    let loader = ThumbnailLoader()
    let sessions = urls.map { EditSession(asset: AssetRef(url: $0)) }
    let heartbeat = MainActorHeartbeat()
    let probe = Task { await heartbeat.run() }
    let started = ContinuousClock.now
    let loaded = await withTaskGroup(of: Bool.self, returning: Int.self) { group in
      for (index, url) in urls.enumerated() {
        let session = sessions[index]
        group.addTask {
          async let hydration: Void = session.loadSidecar()
          let bytes = await loader.load(for: url)
          let image = await ThumbnailDecoder.image(for: bytes, key: url.path)
          await hydration
          return image != nil
        }
      }
      var count = 0
      for await success in group { if success { count += 1 } }
      return count
    }
    probe.cancel()
    await probe.value
    XCTAssertEqual(loaded, 250)
    let gaps = heartbeat.gaps.sorted()
    XCTAssertGreaterThan(gaps.count, 10)
    guard !gaps.isEmpty else { return }
    let p95 = gaps[min(gaps.count - 1, Int(Double(gaps.count) * 0.95))]
    print(
      "Browse cold RAW load: 250 images in \(started.duration(to: .now)); main-actor heartbeat p95=\(p95)ms max=\(gaps.last!)ms samples=\(gaps.count)"
    )
    XCTAssertLessThan(p95, 16, "Background image loading consumed the main actor's frame budget")
    XCTAssertTrue(sessions.allSatisfy { !$0.pipeline.contextStorage.isInitialized })
  }
}

@MainActor
private final class MainActorHeartbeat {
  var gaps: [Double] = []

  func run() async {
    var previous = ContinuousClock.now
    while !Task.isCancelled {
      do { try await Task.sleep(for: .milliseconds(1)) } catch { return }
      let now = ContinuousClock.now
      let duration = previous.duration(to: now).components
      gaps.append(Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1e15)
      previous = now
    }
  }
}
