import Foundation
import XCTest

@testable import MapleCore

extension NativeExportSnapshotTests {
  func testStartupRetirementReservesActorButKeepsIndependentProcessLock() async throws {
    let fixture = try await Self.startupRetirementFixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let fence = NativeExportTestFence()
    let queue = NativeExportQueue(directory: fixture.directory) { record in
      if record.retiredJobs != nil { await fence.arrive() }
    }
    let first = Task { try await queue.run() }
    await fence.wait()
    var secondError: Error?
    do { try await queue.run() } catch { secondError = error }
    var independentError: Error?
    do { try await NativeExportQueue(directory: fixture.directory).run() } catch {
      independentError = error
    }
    await fence.release()
    try await first.value
    XCTAssertNil(secondError, "A joined same-actor run must return without a second flock")
    XCTAssertTrue(independentError?.localizedDescription.contains("Another Maple process") == true)
    let completed = try await queue.load()
    XCTAssertEqual(completed?.successes, 1)
    XCTAssertNil(completed?.retiredJobs)
    XCTAssertEqual(try Data(contentsOf: fixture.original), fixture.originalBytes)
  }

  func testCancelDuringStartupRetirementPublishesNothingAndExplicitResumeWorks() async throws {
    let fixture = try await Self.startupRetirementFixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let fence = NativeExportTestFence()
    let queue = NativeExportQueue(directory: fixture.directory) { record in
      if record.retiredJobs != nil { await fence.arrive() }
    }
    let first = Task { try await queue.run() }
    await fence.wait()
    var cancelError: Error?
    do { try await queue.cancel() } catch { cancelError = error }
    await fence.release()
    try await first.value
    XCTAssertNil(cancelError)
    let cancelled = try await queue.load()
    XCTAssertEqual(cancelled?.phase, "cancelled")
    XCTAssertEqual(cancelled?.cancelRequested, true)
    XCTAssertEqual(cancelled?.successes, 0)
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: fixture.output.path).isEmpty)
    try await queue.run()
    let resumed = try await queue.load()
    XCTAssertEqual(resumed?.successes, 1)
    XCTAssertEqual(resumed?.cancelRequested, false)
    XCTAssertEqual(try Data(contentsOf: fixture.original), fixture.originalBytes)
  }

  func testStartupReservationResetsAfterMissingAndMalformedLedgers() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let directory = fixture.directory.appendingPathComponent("queue")
    let ledger = directory.appendingPathComponent("queue.json")
    let queue = NativeExportQueue(directory: directory)
    try await queue.run()
    try Data("malformed actual saved ledger".utf8).write(to: ledger)
    var failure: Error?
    do { try await queue.run() } catch { failure = error }
    XCTAssertNotNil(failure)
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    try NativeExportStorage.write(record, to: ledger)
    try await queue.run()
    let completed = try await queue.load()
    XCTAssertEqual(completed?.successes, 1)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }

  private static func startupRetirementFixture() async throws -> (
    root: URL, directory: URL, output: URL, original: URL, originalBytes: Data
  ) {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-startup-retirement")
    let original = try jpeg(root)
    let originalBytes = try Data(contentsOf: original)
    let session = try await byteSession(original, root: root)
    let directory = root.appendingPathComponent("queue")
    let output = root.appendingPathComponent("outputs")
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let recipe = ExportRecipe(
      format: "png", quality: nil, destination: "directory", directory: output.path,
      overwritePolicy: "error")
    let old = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe, destination: output, workspace: directory)
    var next = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe, destination: output, workspace: directory)
    next.retiredJobs = [try XCTUnwrap(old.ownedJob)]
    try NativeExportStorage.write(next, to: directory.appendingPathComponent("queue.json"))
    return (root, directory, output, original, originalBytes)
  }
}
