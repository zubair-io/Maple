import Foundation
import XCTest

@testable import MapleCore

extension NativeExportSnapshotTests {
  func testRejectedCaptureReleasesOnlyItsUnpersistedPrivateOriginal() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-rejected-capture")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let session = try await Self.byteSession(original, root: root)
    let directory = root.appendingPathComponent("queue")
    let recipe = ExportRecipe(
      destination: "directory", directory: root.path, overwritePolicy: "error")
    let first = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe, destination: root, workspace: directory)
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(first)
    let rejected = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe, destination: root, workspace: directory)
    do {
      try await queue.enqueue(rejected)
      XCTFail("A pending saved queue must reject the next captured selection")
    } catch { XCTAssertTrue(error.localizedDescription.contains("saved export")) }
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: rejected.originals[0].url.path),
      "A pre-persistence rejection must release the capture it never adopted")
    XCTAssertEqual(try Data(contentsOf: first.originals[0].url), before)
    XCTAssertEqual(try Data(contentsOf: original), before)
    let persisted = try JSONDecoder().decode(
      NativeExportRecord.self,
      from: Data(contentsOf: directory.appendingPathComponent("queue.json")))
    XCTAssertEqual(persisted.id, first.id)
  }

  func testCancelledCompletedCaptureReleasesItsRealPrivateBytes() async throws {
    let (root, original, before, directory, captured) = try await cleanupCapture()
    defer { try? FileManager.default.removeItem(at: root) }
    let queue = NativeExportQueue(directory: directory)
    let cleanup = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      try await queue.releaseUnenqueuedCapture(captured)
    }
    try await cleanup.value
    XCTAssertFalse(FileManager.default.fileExists(atPath: captured.originals[0].url.path))
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testPostPersistenceRetirementFailureRetainsTheNewCapture() async throws {
    let (root, original, before, directory, initial) = try await cleanupCapture()
    defer { try? FileManager.default.removeItem(at: root) }
    var old = initial
    old.phase = "done"
    old.items[0].status = "failed"
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(old)
    let session = try await Self.byteSession(original, root: root)
    let next = try await NativeExportCapture.record(
      sessions: [session], recipe: old.recipe,
      destination: root, workspace: directory)
    try Data("foreign capture replacement".utf8).write(to: old.originals[0].url)
    do {
      try await queue.enqueue(next)
      XCTFail("Changed old private bytes must reject retirement after new persistence")
    } catch { XCTAssertTrue(error.localizedDescription.contains("preserved")) }
    try await queue.releaseUnenqueuedCapture(next)
    XCTAssertEqual(try Data(contentsOf: next.originals[0].url), before)
    let saved = try JSONDecoder().decode(
      NativeExportRecord.self,
      from: Data(contentsOf: directory.appendingPathComponent("queue.json")))
    XCTAssertEqual(saved.id, next.id)
    XCTAssertEqual(saved.ownedJob, next.ownedJob)
    XCTAssertEqual(saved.originals, next.originals)
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testUnreadableQueuePreservesUnadoptedCapture() async throws {
    let (root, original, before, directory, captured) = try await cleanupCapture()
    defer { try? FileManager.default.removeItem(at: root) }
    let ledger = directory.appendingPathComponent("queue.json")
    let unreadable = Data("unreadable saved queue".utf8)
    try unreadable.write(to: ledger)
    let queue = NativeExportQueue(directory: directory)
    do {
      try await queue.releaseUnenqueuedCapture(captured)
      XCTFail("An unreadable ledger cannot prove a capture is unreferenced")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: captured.originals[0].url), before)
    XCTAssertEqual(try Data(contentsOf: ledger), unreadable)
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testUnadoptedCaptureCleanupPreservesForeignReplacement() async throws {
    let (root, original, before, directory, captured) = try await cleanupCapture()
    defer { try? FileManager.default.removeItem(at: root) }
    let foreign = Data("foreign bytes must never be removed".utf8)
    try foreign.write(to: captured.originals[0].url)
    let queue = NativeExportQueue(directory: directory)
    do {
      try await queue.releaseUnenqueuedCapture(captured)
      XCTFail("Capture cleanup must prove the actual file identity and bytes")
    } catch { XCTAssertTrue(error.localizedDescription.contains("preserved")) }
    let claimed = directory.appendingPathComponent("Jobs/Retired-\(captured.id.uuidString)/Sources")
      .appendingPathComponent(captured.originals[0].url.lastPathComponent)
    XCTAssertEqual(try Data(contentsOf: claimed), foreign)
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  private func cleanupCapture() async throws -> (URL, URL, Data, URL, NativeExportRecord) {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-capture-release")
    let original = try Self.jpeg(root)
    let before = try Data(contentsOf: original)
    let session = try await Self.byteSession(original, root: root)
    let directory = root.appendingPathComponent("queue")
    let recipe = ExportRecipe(
      destination: "directory", directory: root.path, overwritePolicy: "error")
    let captured = try await NativeExportCapture.record(
      sessions: [session], recipe: recipe,
      destination: root, workspace: directory)
    return (root, original, before, directory, captured)
  }

}
