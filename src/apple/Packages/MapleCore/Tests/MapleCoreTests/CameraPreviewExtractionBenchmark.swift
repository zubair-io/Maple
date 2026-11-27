import Foundation
import RawPipeline
import XCTest

@testable import MapleCore

// Opt-in: MAPLE_PERF=1 MAPLE_PERF_RAW_DIR=<dir of RAWs> swift test -c release --filter CameraPreviewExtractionBenchmark
final class CameraPreviewExtractionBenchmark: XCTestCase {
  private let passes = 5

  private func viaTempFile(_ raw: URL, scratch: URL) -> Data? {
    let output = scratch.appendingPathComponent("\(UUID().uuidString).jpg")
    defer { try? FileManager.default.removeItem(at: output) }
    let result = raw.path.withCString { rawPath in
      output.path.withCString { outPath in
        maple_render_thumbnail_preview_jpeg_to_file(
          rawPath, outPath, UInt32(ThumbnailLoader.displayPreviewLongEdge), 85)
      }
    }
    return result == 0 ? try? Data(contentsOf: output) : nil
  }

  private func milliseconds(_ body: () -> Void) -> Double {
    let start = DispatchTime.now().uptimeNanoseconds
    body()
    return Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
  }

  private func median(_ values: [Double]) -> Double {
    let sorted = values.sorted()
    return sorted[sorted.count / 2]
  }

  func testTempFileVersusInMemoryExtraction() throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["MAPLE_PERF"] == "1", let dir = environment["MAPLE_PERF_RAW_DIR"] else {
      throw XCTSkip("perf benchmark — set MAPLE_PERF=1 and MAPLE_PERF_RAW_DIR")
    }
    let scratch = FileManager.default.temporaryDirectory
      .appendingPathComponent("camera-preview-bench-\(UUID())")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: scratch) }

    let candidates = try FileManager.default.contentsOfDirectory(
      at: URL(fileURLWithPath: dir), includingPropertiesForKeys: nil
    ).filter { !$0.hasDirectoryPath && $0.pathExtension.lowercased() != "jpg" }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
    let files = candidates.filter { viaTempFile($0, scratch: scratch) != nil }
    XCTAssertGreaterThanOrEqual(files.count, 20)
    for file in files {
      XCTAssertEqual(
        ThumbnailLoader.embeddedCameraJPEG(at: file), viaTempFile(file, scratch: scratch),
        file.lastPathComponent)
    }

    let rows = files.map { file -> (String, Double, Double, Double, Double) in
      let timed = (0...passes).map { pass -> (file: Double, buffer: Double) in
        if pass.isMultiple(of: 2) {
          let f = milliseconds { _ = viaTempFile(file, scratch: scratch) }
          let b = milliseconds { _ = ThumbnailLoader.embeddedCameraJPEG(at: file) }
          return (f, b)
        }
        let b = milliseconds { _ = ThumbnailLoader.embeddedCameraJPEG(at: file) }
        let f = milliseconds { _ = viaTempFile(file, scratch: scratch) }
        return (f, b)
      }.dropFirst()
      let fileTimes = timed.map(\.file)
      let bufferTimes = timed.map(\.buffer)
      return (
        file.lastPathComponent, fileTimes.min() ?? 0, median(fileTimes), bufferTimes.min() ?? 0,
        median(bufferTimes)
      )
    }
    print("PERF file min/median ms | buffer min/median ms")
    for r in rows {
      print(
        "PERF \(r.0) | \(String(format: "%.2f %.2f", r.1, r.2)) | \(String(format: "%.2f %.2f", r.3, r.4))"
      )
    }
    let totals = rows.reduce((0.0, 0.0, 0.0, 0.0)) {
      ($0.0 + $1.1, $0.1 + $1.2, $0.2 + $1.3, $0.3 + $1.4)
    }
    print(
      "PERF TOTAL files=\(rows.count) passes=\(passes) file min=\(String(format: "%.1f", totals.0)) median=\(String(format: "%.1f", totals.1)) | buffer min=\(String(format: "%.1f", totals.2)) median=\(String(format: "%.1f", totals.3))"
    )
  }
}
