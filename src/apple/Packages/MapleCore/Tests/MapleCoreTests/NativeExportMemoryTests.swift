import Darwin
import Foundation
import ImageIO
import XCTest

@testable import MapleCore

/// Explicit local feasibility probe; timings under concurrent builds are not product budgets (#4113).
final class NativeExportMemoryTests: XCTestCase {
  func testActualFullOwnedVolumeFailsActionablyAndCanRetry() async throws {
    guard let rootPath = ProcessInfo.processInfo.environment["MAPLE_SWIFT_TEST_ROOT"] else {
      throw XCTSkip("Requires an explicitly mounted owned disk-full qualification volume.")
    }
    let root = URL(fileURLWithPath: rootPath)
    let volume = root.appendingPathComponent("disk-full-volume", isDirectory: true)
    let values = try volume.resourceValues(forKeys: [.volumeURLKey])
    guard values.volume == volume else {
      throw XCTSkip("disk-full-volume must itself be an owned mounted volume, never the host disk.")
    }
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let original = try Data(contentsOf: fixture.raw)
    let filler = volume.appendingPathComponent("owned-test-filler")
    XCTAssertTrue(FileManager.default.createFile(atPath: filler.path, contents: nil))
    defer { try? FileManager.default.removeItem(at: filler) }
    let handle = try FileHandle(forWritingTo: filler)
    defer { try? handle.close() }
    let chunk = Data(repeating: 0x61, count: 4096)
    do {
      for _ in 0..<8192 { try handle.write(contentsOf: chunk) }
      XCTFail("Bounded 32 MiB filler did not exhaust the owned 16 MiB volume.")
      return
    } catch {
      let value = error as NSError
      XCTAssertTrue(
        value.domain == NSCocoaErrorDomain && value.code == NSFileWriteOutOfSpaceError
          || value.domain == NSPOSIXErrorDomain && value.code == Int(ENOSPC))
    }
    let initial = try NativeExportQueueFixture.record(
      fixture.raw, root: fixture.directory, stem: "full-\(UUID().uuidString)")
    var recipe = initial.recipe
    recipe.directory = volume.path
    let record = NativeExportRecord(
      version: initial.version, id: initial.id, recipe: recipe,
      destinationBookmark: try NativeExportAccess.bookmark(volume), originals: initial.originals,
      filmDirectory: nil, filmHashes: [:], items: initial.items)
    let queue = NativeExportQueue(directory: fixture.directory.appendingPathComponent("ledger"))
    try await queue.enqueue(record)
    try await queue.run()
    let failed = try await queue.load()
    XCTAssertEqual(failed?.failures, 1)
    XCTAssertTrue(
      failed?.items.first?.reason?.localizedCaseInsensitiveContains("destination is full") == true)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), original)
    try handle.close()
    try FileManager.default.removeItem(at: filler)
    try await queue.retryFailed()
    try await queue.run()
    let finished = try await queue.load()
    XCTAssertEqual(finished?.successes, 1, finished?.items.first?.reason ?? "")
    XCTAssertEqual(try Data(contentsOf: fixture.raw), original)
  }

  func testTwoReal100MPExportsRunSeriallyAndRetainOriginalHash() async throws {
    guard let rootPath = ProcessInfo.processInfo.environment["MAPLE_SWIFT_TEST_ROOT"] else {
      throw XCTSkip(
        "Requires an explicitly staged owned 100MP fixture for native export qualification.")
    }
    let root = URL(fileURLWithPath: rootPath)
    let source = root.appendingPathComponent("large-source.dng")
    guard FileManager.default.fileExists(atPath: source.path) else {
      throw XCTSkip("No large-source.dng in the explicitly staged test root.")
    }
    let before = try XCTUnwrap(NativeExportStorage.hash(source))
    XCTAssertEqual(before, "f4b60b3672bdf7ff7f4376fba9da1b1d22c925ebc3e16baa5fd4a64fa1045aa5")
    let workspace = root.appendingPathComponent("run-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    var record = try NativeExportQueueFixture.record(
      source, root: workspace, stem: "large-0", index: 0)
    let second = try NativeExportQueueFixture.record(
      source, root: workspace, stem: "large-1", index: 1)
    record.originals += second.originals
    record.items += second.items
    let recipe = ExportRecipe(
      format: "jpeg", quality: 92, outputProfile: "display-p3",
      destination: "directory", directory: workspace.appendingPathComponent("outputs").path,
      overwritePolicy: "error")
    record = NativeExportQueueFixture.replacingRecipe(record, recipe)
    let checkpoint = NativeExportMemoryCheckpoint()
    let queue = NativeExportQueue(directory: workspace.appendingPathComponent("ledger")) { value in
      await checkpoint.record(value)
    }
    try await queue.enqueue(record)
    let began = ProcessInfo.processInfo.systemUptime
    try await queue.run()
    let elapsed = ProcessInfo.processInfo.systemUptime - began
    let finished = try await queue.load()
    XCTAssertEqual(finished?.successes, 2)
    let completed = try XCTUnwrap(finished)
    var outputs: [[String: Any]] = []
    for item in completed.items {
      let output = try XCTUnwrap(item.output)
      let image = try XCTUnwrap(CGImageSourceCreateWithURL(output as CFURL, nil))
      let properties = try XCTUnwrap(
        CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [String: Any])
      let width = try XCTUnwrap(properties[kCGImagePropertyPixelWidth as String] as? Int)
      let height = try XCTUnwrap(properties[kCGImagePropertyPixelHeight as String] as? Int)
      XCTAssertGreaterThan(width * height, 90_000_000)
      XCTAssertNotNil(CGImageSourceCreateImageAtIndex(image, 0, nil))
      outputs.append([
        "path": output.path, "width": width, "height": height,
        "bytes": try Data(contentsOf: output).count,
        "sha256": try XCTUnwrap(NativeExportStorage.hash(output)),
      ])
    }
    XCTAssertEqual(try NativeExportStorage.hash(source), before)
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    let transitions = await checkpoint.transitions
    XCTAssertEqual(transitions.filter { $0 == "rendering" }.count, 2)
    let report: [String: Any] = [
      "fixtureSha256": before, "exports": outputs,
      "elapsedSeconds": elapsed, "peakProcessRssBytes": usage.ru_maxrss,
      "queueTransitions": transitions,
      "qualification":
        "loaded-machine serial native feasibility; not a 16ms slider or quiet-machine memory budget",
      "process": ProcessInfo.processInfo.processIdentifier,
    ]
    try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      .write(to: root.appendingPathComponent("native-4113-100mp-report.json"), options: .atomic)
  }
}

private actor NativeExportMemoryCheckpoint {
  var transitions: [String] = []
  private var previous: [String: String] = [:]
  func record(_ record: NativeExportRecord) {
    for item in record.items where previous[item.id] != item.status {
      previous[item.id] = item.status
      transitions.append(item.status)
    }
  }
}
