import CoreImage
import Darwin
import Foundation
import ImageIO
import XCTest

@testable import MapleCore

extension ReportedExportParityTests {
  func test100MPZeroRemovalPNGExport() async throws { try await measure100MPExport(0, .png) }
  func test100MPOneRemovalPNGExport() async throws { try await measure100MPExport(1, .png) }
  func test100MPTenRemovalPNGExport() async throws { try await measure100MPExport(10, .png) }
  func test100MPZeroRemovalTIFFExport() async throws { try await measure100MPExport(0, .tiff16) }
  func test100MPOneRemovalTIFFExport() async throws { try await measure100MPExport(1, .tiff16) }
  func test100MPTenRemovalTIFFExport() async throws { try await measure100MPExport(10, .tiff16) }

  /// Run one method per fresh XCTest process to isolate cold caches and peak RSS.
  /// Controlled accepted patches measure delivery; they never establish AI quality.
  private func measure100MPExport(_ count: Int, _ format: ExportFileFormat) async throws {
    guard ProcessInfo.processInfo.environment["MAPLE_PERF"] == "1" else {
      throw XCTSkip("Opt in with MAPLE_PERF=1; run each 100MP export method in a fresh process")
    }
    let root = SliderTickPerfHarness.repoRoot()
    let source = root.appendingPathComponent("test-fixtures/raws/dji-mavic3pro-100mp.dng")
    let fixtures = root.appendingPathComponent("test-fixtures/raws/removal-perf")
    let sourceXMP = fixtures.appendingPathComponent("stack-\(count).xmp")
    guard FileManager.default.fileExists(atPath: source.path),
      FileManager.default.fileExists(atPath: sourceXMP.path)
    else {
      throw RemovalError.invalid(
        "Explicit 100MP qualification requires the canonical RAW and accepted stacks")
    }
    let expectedHash = "f4b60b3672bdf7ff7f4376fba9da1b1d22c925ebc3e16baa5fd4a64fa1045aa5"
    guard try SidecarContractIO.sha256(of: source) == expectedHash else {
      throw RemovalError.invalid("The named 100MP RAW does not match the canonical source")
    }
    let sourceXMPBytes = try Data(contentsOf: sourceXMP)
    let model = try XMPParser.parse(data: sourceXMPBytes).0
    let records = model.inpaintRemovals?.json ?? "[]"
    let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(records.utf8)) as? [Any])
    XCTAssertEqual(rows.count, count)
    guard rows.count == count, model.profile == .auto else {
      throw RemovalError.invalid("The export must use the exact accepted stack and Auto profile")
    }
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "100mp-export-1472")
    // Delivery artifacts survive the test for inspection; staged originals and
    // companions are removed on completion, including a failed verification.
    let raw = directory.appendingPathComponent("source.dng")
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let companions = directory.appendingPathComponent(".maple")
    defer {
      try? FileManager.default.removeItem(at: raw)
      try? FileManager.default.removeItem(at: sidecar)
      try? FileManager.default.removeItem(at: companions)
    }
    try FileManager.default.copyItem(at: source, to: raw)
    try sourceXMPBytes.write(to: sidecar)
    if count > 0 {
      try FileManager.default.copyItem(
        at: fixtures.appendingPathComponent(".maple"), to: companions)
    }
    let session = EditSession(asset: AssetRef(url: raw), model: model)
    let quality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
    let began = ContinuousClock.now
    let bytes: Data
    do {
      bytes = try await MapleExporter.exportData(session: session, options: .init(format: format))
    } catch {
      await session.releaseTransientMemory()
      throw error
    }
    let exportMs = durationMs(began.duration(to: .now))
    let deliveryPeakRSS = try processPeakRSS()
    let destination = directory.appendingPathComponent("stack-\(count).\(format.fileExtension)")
    try bytes.write(to: destination)
    await session.releaseTransientMemory()
    var report = PerfRecordWriter.deviceSnapshot()
    report["case"] = "100MP-native-float-removal-export"
    report["patchCount"] = count
    report["format"] = format.rawValue
    report["profile"] = "auto"
    report["quality"] = quality == .amaze ? "amaze" : "full"
    report["exportMs"] = exportMs
    report["deliveryPeakRSSBytes"] = deliveryPeakRSS
    report["physicalMemoryBytes"] = ProcessInfo.processInfo.physicalMemory
    report["sourceSha256"] = expectedHash
    report["exportBytes"] = bytes.count
    report["artifactDirectory"] = directory.path
    report["commitSha"] = PerfRecordWriter.gitCommitSha()
    report["memoryScope"] =
      "Fresh process high-water RSS through exportData, before verification; includes fixture staging/test runtime; excludes subsequent ImageIO decode/reference render"
    report["timingScope"] =
      "Production full render plus encode, before file write; native caches cold, OS source pages warmed by identity check/copy; no live viewport or inference"
    emit100MPReport(report, phase: "delivery")
    try await verify100MPDelivery(
      bytes, format: format, raw: raw, sidecar: sidecar, quality: quality, report: &report)
    XCTAssertEqual(try SidecarContractIO.sha256(of: source), expectedHash)
    XCTAssertEqual(try SidecarContractIO.sha256(of: raw), expectedHash)
    XCTAssertEqual(try Data(contentsOf: sourceXMP), sourceXMPBytes)
    XCTAssertEqual(try Data(contentsOf: sidecar), sourceXMPBytes)
    let reportBytes = try JSONSerialization.data(
      withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try reportBytes.write(to: directory.appendingPathComponent("qualification.json"))
    emit100MPReport(report, phase: "comparison")
  }

  private func verify100MPDelivery(
    _ bytes: Data, format: ExportFileFormat, raw: URL, sidecar: URL,
    quality: PipelineRenderer.Quality, report: inout [String: Any]
  ) async throws {
    let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    XCTAssertEqual([image.width, image.height], [12288, 8192])
    XCTAssertEqual(image.bitsPerComponent, format == .tiff16 ? 16 : 8)
    guard image.width == 12288, image.height == 8192,
      image.bitsPerComponent == (format == .tiff16 ? 16 : 8)
    else { throw RemovalError.invalid("100MP export dimensions or bit depth changed") }
    let reference = try PipelineRenderer.render(rawPath: raw, xmpPath: sidecar, quality: quality)
    XCTAssertEqual([reference.width, reference.height], [image.width, image.height])
    let delivered = CIImage(cgImage: image)
    var rgba = Data(count: image.width * image.height * 4)
    rgba.withUnsafeMutableBytes {
      CIContext(options: [.workingFormat: CIFormat.RGBAf, .cacheIntermediates: false]).render(
        delivered, toBitmap: $0.baseAddress!, rowBytes: image.width * 4,
        bounds: delivered.extent, format: .RGBA8,
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    let stats = rgba.withUnsafeBytes { actual in
      reference.pixels.withUnsafeBytes { expected in
        let a = actual.bindMemory(to: UInt8.self)
        let b = expected.bindMemory(to: UInt8.self)
        return (0..<b.count).reduce((max: 0, over1: 0, sum: UInt64(0))) { result, index in
          let error = abs(Int(a[index / 3 * 4 + index % 3]) - Int(b[index]))
          return (
            max(result.max, error), result.over1 + (error > 1 ? 1 : 0), result.sum + UInt64(error)
          )
        }
      }
    }
    XCTAssertLessThanOrEqual(stats.max, 1, "Actual full-resolution delivery must match shared RAW")
    XCTAssertEqual(stats.over1, 0)
    report["width"] = image.width
    report["height"] = image.height
    report["bitsPerComponent"] = image.bitsPerComponent
    report["maximumChannelError"] = stats.max
    report["parityPassed"] = stats.max <= 1 && stats.over1 == 0
    report["channelsOver1"] = stats.over1
    report["meanChannelError"] = Double(stats.sum) / Double(reference.pixels.count)
    report["parityLimit"] = "Maximum 1/255 and zero channels over 1, all 301989888 RGB channels"
    report["deliveredRGBADigest"] = try RemovalBridge.digest(rgba)
  }

  private func processPeakRSS() throws -> Int64 {
    var usage = rusage()
    guard getrusage(RUSAGE_SELF, &usage) == 0 else {
      throw RemovalError.invalid("Could not measure native export process RSS")
    }
    // Darwin reports bytes, unlike Linux's KiB field.
    return Int64(usage.ru_maxrss)
  }

  private func durationMs(_ duration: Duration) -> Double {
    Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
  }

  private func emit100MPReport(_ report: [String: Any], phase: String) {
    var row = report
    row["phase"] = phase
    if let json = try? JSONSerialization.data(withJSONObject: row, options: .sortedKeys) {
      print("MAPLE_REMOVAL_100MP_EXPORT \(String(decoding: json, as: UTF8.self))")
    }
  }
}
