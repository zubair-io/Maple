import Darwin
import Foundation
import XCTest

@testable import MapleCore

final class NativeExportQueueTests: XCTestCase {
  func testResumeRejectsEqualByteReplacementUntilExplicitAuthorization() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    var record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    var source = record.originals[0]
    source.scopeURL = fixture.directory
    source.bookmark = try NativeExportAccess.bookmark(fixture.directory)
    source.relativePath = fixture.raw.lastPathComponent
    record.originals[0] = source
    let initial = record.items[0].target
    record.items[0] = NativeExportItem(
      target: NativeExportTarget(
        source: source, stem: initial.stem, xmp: initial.xmp,
        capturedAt: initial.capturedAt, index: initial.index))
    let directory = fixture.directory.appendingPathComponent("ledger")
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(record)
    let original = fixture.directory.appendingPathComponent("captured-original.dng")
    try FileManager.default.moveItem(at: fixture.raw, to: original)
    try fixture.original.write(to: fixture.raw, options: .withoutOverwriting)
    XCTAssertNotEqual(try NativeExportStorage.identity(fixture.raw), record.originals[0].identity)
    let restored = NativeExportQueue(directory: directory)
    let loaded = try await restored.load()
    let frozen = try XCTUnwrap(loaded)
    let beforeAccess = try NativeExportAccess(record: frozen)
    XCTAssertThrowsError(
      try NativeExportPublication.prepare(frozen.items[0], record: frozen, access: beforeAccess))
    try await restored.authorizeSource(id: record.originals[0].id, url: fixture.raw)
    let authorized = try await restored.load()
    let renewed = try XCTUnwrap(authorized)
    XCTAssertEqual(renewed.originals[0].identity, record.originals[0].identity)
    XCTAssertEqual(
      renewed.originals[0].authorizedIdentity, try NativeExportStorage.identity(fixture.raw))
    let access = try NativeExportAccess(record: renewed)
    let rendering = try NativeExportPublication.prepare(
      renewed.items[0], record: renewed, access: access)
    let prepared = try NativeExportPublication.render(rendering, record: renewed, access: access)
    let applied = try NativeExportPublication.publish(
      prepared, record: renewed, access: access, cancellation: NativeExportCancellation())
    XCTAssertEqual(applied.status, "applied")
    let originalAlias = fixture.directory.appending(path: "outputs/original-alias.dng")
    try FileManager.default.linkItem(at: original, to: originalAlias)
    XCTAssertThrowsError(try access.protect(originalAlias, originals: renewed.originals))
    XCTAssertEqual(try Data(contentsOf: original), fixture.original)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    let chosen = fixture.directory.appendingPathComponent("authorized-original.dng")
    try FileManager.default.moveItem(at: fixture.raw, to: chosen)
    try fixture.original.write(to: fixture.raw, options: .withoutOverwriting)
    XCTAssertThrowsError(
      try NativeExportPublication.prepare(renewed.items[0], record: renewed, access: access))
    let chosenAlias = fixture.directory.appending(path: "outputs/authorized-alias.dng")
    try FileManager.default.linkItem(at: chosen, to: chosenAlias)
    XCTAssertThrowsError(try access.protect(chosenAlias, originals: renewed.originals))
    XCTAssertEqual(try Data(contentsOf: chosen), fixture.original)
  }

  func testPublicationRejectsEqualByteSourceReplacementAfterEncoding() throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    let access = try NativeExportAccess(record: record)
    let rendering = try NativeExportPublication.prepare(
      record.items[0], record: record, access: access)
    let prepared = try NativeExportPublication.render(rendering, record: record, access: access)
    let staging = try XCTUnwrap(prepared.staging)
    let output = try XCTUnwrap(prepared.output)
    let original = fixture.directory.appendingPathComponent("captured-original.dng")
    try FileManager.default.moveItem(at: fixture.raw, to: original)
    try fixture.original.write(to: fixture.raw, options: .withoutOverwriting)
    XCTAssertNotEqual(try NativeExportStorage.identity(fixture.raw), record.originals[0].identity)
    XCTAssertThrowsError(
      try NativeExportPublication.publish(
        prepared, record: record, access: access, cancellation: NativeExportCancellation()))
    XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    XCTAssertEqual(try NativeExportStorage.hash(staging), prepared.afterHash)
    XCTAssertEqual(try Data(contentsOf: original), fixture.original)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }

  func testPreparedRecoveryRequiresPublishedInodeAsWellAsEqualBytes() throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    let access = try NativeExportAccess(record: record)
    let rendering = try NativeExportPublication.prepare(
      record.items[0], record: record, access: access)
    let prepared = try NativeExportPublication.render(rendering, record: record, access: access)
    let staging = try XCTUnwrap(prepared.staging)
    let output = try XCTUnwrap(prepared.output)
    let bytes = try Data(contentsOf: staging)
    try bytes.write(to: output, options: .withoutOverwriting)
    XCTAssertNotEqual(try NativeExportStorage.identity(output), prepared.stagingIdentity)
    XCTAssertThrowsError(
      try NativeExportPublication.prepare(prepared, record: record, access: access))
    XCTAssertEqual(try Data(contentsOf: staging), bytes)
    try FileManager.default.removeItem(at: output)
    try FileManager.default.moveItem(at: staging, to: output)
    let recovered = try NativeExportPublication.prepare(prepared, record: record, access: access)
    XCTAssertEqual(recovered.status, "applied")
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }

  func testPreparedStagingFifoIsRejectedBeforeReadingAndPreservesOriginal() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    let fence = NativeExportTestFence()
    let queue = NativeExportQueue(directory: fixture.directory.appendingPathComponent("ledger")) {
      value in
      if value.items.contains(where: { $0.status == "prepared" }) { await fence.arrive() }
    }
    try await queue.enqueue(record)
    let run = Task { try await queue.run() }
    await fence.wait()
    let saved = try await queue.load()
    let prepared = try XCTUnwrap(saved)
    let item = try XCTUnwrap(prepared.items.first)
    let staging = try XCTUnwrap(item.staging)
    try FileManager.default.removeItem(at: staging)
    XCTAssertEqual(Darwin.mkfifo(staging.path, 0o600), 0)
    let access = try NativeExportAccess(record: prepared)
    XCTAssertThrowsError(
      try NativeExportPublication.staging(item, record: prepared, access: access))
    try await queue.cancel()
    await fence.release()
    try await run.value
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    let values = try staging.resourceValues(forKeys: [.isRegularFileKey])
    XCTAssertEqual(values.isRegularFile, false)
  }

  func testRetryRetainsAllInitialOriginalsAndSequenceAcrossReload() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    var record = try NativeExportQueueFixture.record(
      fixture.raw, root: fixture.directory, stem: "other", index: 9)
    let outputs = fixture.directory.appendingPathComponent("outputs")
    let other = outputs.appendingPathComponent("other.png")
    try fixture.original.write(to: other)
    let second = try NativeExportQueueFixture.record(
      other, root: fixture.directory, stem: "second", index: 22)
    record.originals += second.originals
    record.items += second.items
    let directory = fixture.directory.appendingPathComponent("ledger")
    let queue = NativeExportQueue(directory: directory)
    try await queue.enqueue(record)
    try await queue.run()
    let firstRun = try await queue.load()
    XCTAssertEqual(firstRun?.items.map(\.status), ["failed", "applied"])
    XCTAssertEqual(try Data(contentsOf: other), fixture.original)
    let restored = NativeExportQueue(directory: directory)
    try await restored.retryFailed()
    let retry = try await restored.load()
    XCTAssertEqual(retry?.items.count, 1)
    XCTAssertEqual(retry?.items.first?.target.index, 9)
    XCTAssertEqual(retry?.originals, record.originals)
    XCTAssertEqual(retry?.items.first?.target.xmp, record.items.first?.target.xmp)
    try await restored.run()
    let final = try await restored.load()
    XCTAssertEqual(final?.failures, 1)
    XCTAssertEqual(try Data(contentsOf: other), fixture.original)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }

  func testSiblingOutputNameCollisionFailsInsteadOfReplacingAndLeavesNoStaging() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let copy = fixture.directory.appendingPathComponent("copy.dng")
    try fixture.original.write(to: copy)
    let first = try NativeExportQueueFixture.record(
      fixture.raw, root: fixture.directory, stem: "dup", index: 1)
    let second = try NativeExportQueueFixture.record(
      copy, root: fixture.directory, stem: "dup", index: 2)
    var recipe = first.recipe
    recipe.overwritePolicy = "replace"
    var record = NativeExportQueueFixture.replacingRecipe(first, recipe)
    record.originals += second.originals
    record.items += second.items
    let queue = NativeExportQueue(directory: fixture.directory.appendingPathComponent("ledger"))
    try await queue.enqueue(record)
    try await queue.run()
    let finished = try await queue.load()
    XCTAssertEqual(finished?.items.map(\.status), ["applied", "failed"])
    XCTAssertTrue(finished?.items.last?.reason?.contains("already uses dup.png") == true)
    let outputs = fixture.directory.appendingPathComponent("outputs")
    let names = try FileManager.default.contentsOfDirectory(atPath: outputs.path)
    XCTAssertEqual(names, ["dup.png"])
    XCTAssertEqual(
      try NativeExportStorage.hash(outputs.appendingPathComponent("dup.png")),
      finished?.items.first?.afterHash)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }

  func testSavedDeviceAndInodeProtectRenamedOriginalHardLinkAfterReload() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    let queue = NativeExportQueue(directory: fixture.directory.appendingPathComponent("ledger"))
    try await queue.enqueue(record)
    let moved = fixture.directory.appendingPathComponent("moved.dng")
    try FileManager.default.moveItem(at: fixture.raw, to: moved)
    let output = fixture.directory.appending(path: "outputs/output.png")
    try FileManager.default.linkItem(at: moved, to: output)
    try await queue.authorizeSource(id: record.originals[0].id, url: moved)
    let restored = try await queue.load()
    let renewed = try XCTUnwrap(restored)
    XCTAssertEqual(renewed.originals[0].identity, record.originals[0].identity)
    let access = try NativeExportAccess(record: renewed)
    XCTAssertThrowsError(try access.protect(output, originals: renewed.originals))
    XCTAssertEqual(try Data(contentsOf: moved), fixture.original)
  }

  func testCancelAfterActualPreparedWriteNeverPublishesLateOutputAndResumeIsExplicit() async throws
  {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    let fence = NativeExportTestFence()
    let queue = NativeExportQueue(directory: fixture.directory.appendingPathComponent("ledger")) {
      value in
      if value.items.contains(where: { $0.status == "prepared" }) { await fence.arrive() }
    }
    try await queue.enqueue(record)
    let run = Task { try await queue.run() }
    await fence.wait()
    let prepared = try await queue.load()
    let staging = try XCTUnwrap(prepared?.items.first?.staging)
    XCTAssertNotNil(try NativeExportStorage.hash(staging))
    try await queue.cancel()
    await fence.release()
    try await run.value
    let cancelled = try await queue.load()
    XCTAssertEqual(cancelled?.phase, "cancelled")
    XCTAssertEqual(cancelled?.remaining, 1)
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: fixture.directory.appending(path: "outputs/output.png").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
    let resumed = NativeExportQueue(directory: queue.directory)
    try await resumed.run()
    let completed = try await resumed.load()
    XCTAssertEqual(completed?.successes, 1)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }

  func testCancellationCleanupPreservesOriginalMovedOntoPreparedStaging() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    let fence = NativeExportTestFence()
    let queue = NativeExportQueue(directory: fixture.directory.appendingPathComponent("ledger")) {
      value in
      if value.items.first?.status == "prepared" { await fence.arrive() }
    }
    try await queue.enqueue(record)
    let run = Task { try await queue.run() }
    await fence.wait()
    let prepared = try await queue.load()
    let staging = try XCTUnwrap(prepared?.items.first?.staging)
    try FileManager.default.removeItem(at: staging)
    try FileManager.default.moveItem(at: fixture.raw, to: staging)
    try await queue.cancel()
    await fence.release()
    try await run.value
    let cancelled = try await queue.load()
    XCTAssertEqual(cancelled?.phase, "cancelled")
    XCTAssertEqual(cancelled?.items.first?.status, "failed")
    XCTAssertEqual(
      try Data(contentsOf: staging), fixture.original,
      "Cancellation must preserve the original's only file, even after an external move to staging."
    )
    XCTAssertEqual(try NativeExportStorage.identity(staging), record.originals[0].identity)
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: fixture.directory.appending(path: "outputs/output.png").path))
  }

  func testSecondQueueCannotOverwriteLedgerDuringNativeRun() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    let fence = NativeExportTestFence()
    let directory = fixture.directory.appendingPathComponent("ledger")
    let queue = NativeExportQueue(directory: directory) { value in
      if value.items.first?.status == "rendering" { await fence.arrive() }
    }
    try await queue.enqueue(record)
    let run = Task { try await queue.run() }
    await fence.wait()
    let second = NativeExportQueue(directory: directory)
    do {
      try await second.enqueue(record)
      XCTFail("A second exporter must not overwrite a locked ledger")
    } catch { XCTAssertTrue(error.localizedDescription.contains("Another Maple process")) }
    do {
      try await second.run()
      XCTFail("A second exporter must not start")
    } catch { XCTAssertTrue(error.localizedDescription.contains("Another Maple process")) }
    await fence.release()
    try await run.value
    let final = try await queue.load()
    XCTAssertEqual(final?.successes, 1)
  }

  func testProcessCrashAfterPreparedDurableWriteRecoversActualEncodedBytes() async throws {
    let marker = "native-export-process-child"
    if let path = ProcessInfo.processInfo.environment["MAPLE_SWIFT_TEST_ROOT"],
      URL(fileURLWithPath: path).lastPathComponent == marker
    {
      let root = URL(fileURLWithPath: path)
      let raw = root.appendingPathComponent("source.dng")
      let record = try NativeExportQueueFixture.record(raw, root: root)
      let queue = NativeExportQueue(directory: root.appendingPathComponent("ledger")) { value in
        if value.items.first?.status == "prepared" { Darwin._exit(77) }
      }
      try await queue.enqueue(record)
      try await queue.run()
      XCTFail("Child must exit after real prepared write")
      return
    }
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let root = fixture.directory.appendingPathComponent(marker, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let raw = root.appendingPathComponent("source.dng")
    try fixture.original.write(to: raw)
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    child.arguments = [
      "-XCTest",
      "MapleCoreTests.NativeExportQueueTests/testProcessCrashAfterPreparedDurableWriteRecoversActualEncodedBytes",
      Bundle(for: NativeExportQueueTests.self).bundlePath,
    ]
    var environment = ProcessInfo.processInfo.environment
    environment["MAPLE_SWIFT_TEST_ROOT"] = root.path
    child.environment = environment
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    try child.run()
    await Task.detached { child.waitUntilExit() }.value
    XCTAssertEqual(child.terminationStatus, 77)
    let queue = NativeExportQueue(directory: root.appendingPathComponent("ledger"))
    let prepared = try await queue.load()
    XCTAssertEqual(prepared?.phase, "interrupted")
    let item = try XCTUnwrap(prepared?.items.first)
    XCTAssertEqual(item.status, "prepared")
    XCTAssertEqual(try NativeExportStorage.hash(try XCTUnwrap(item.staging)), item.afterHash)
    XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(item.output).path))
    try await queue.run()
    let finished = try await queue.load()
    XCTAssertEqual(finished?.successes, 1)
    XCTAssertEqual(try NativeExportStorage.hash(try XCTUnwrap(item.output)), item.afterHash)
    XCTAssertEqual(try Data(contentsOf: raw), fixture.original)
  }

  func testUnreadableLegacyLedgerIsArchivedWithoutChangingBytesAndNewCaptureCanRun() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let directory = fixture.directory.appendingPathComponent("ledger")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let legacy = Data("{\"version\":0,\"legacy\":true}".utf8)
    try legacy.write(to: directory.appendingPathComponent("queue.json"))
    let queue = NativeExportQueue(directory: directory)
    do {
      _ = try await queue.load()
      XCTFail("Unproven legacy data cannot execute")
    } catch {}
    let archived = try await queue.archiveSavedQueue()
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(archived)), legacy)
    let empty = try await queue.load()
    XCTAssertNil(empty)
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    try await queue.enqueue(record)
    try await queue.run()
    let finished = try await queue.load()
    XCTAssertEqual(finished?.successes, 1)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }

  func testActualDestinationPermissionFailureIsActionableAndRetryPreservesOriginal() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    let destination = fixture.directory.appendingPathComponent("outputs")
    let queue = NativeExportQueue(directory: fixture.directory.appendingPathComponent("ledger"))
    try await queue.enqueue(record)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o555], ofItemAtPath: destination.path)
    defer {
      try? FileManager.default.setAttributes(
        [.posixPermissions: 0o755], ofItemAtPath: destination.path)
    }
    try await queue.run()
    let failed = try await queue.load()
    XCTAssertEqual(failed?.failures, 1)
    XCTAssertTrue(failed?.items.first?.reason?.contains("Permission denied") == true)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: destination.path)
    try await queue.retryFailed()
    try await queue.run()
    let finished = try await queue.load()
    XCTAssertEqual(finished?.successes, 1)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }

  func testMissingIdentitiesAndChangedPreparedBytesFailClosed() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    var record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    record.originals = []
    let queue = NativeExportQueue(directory: fixture.directory.appendingPathComponent("ledger"))
    do {
      try await queue.enqueue(record)
      XCTFail("Incomplete identity set must reject")
    } catch {}
    record = try NativeExportQueueFixture.record(fixture.raw, root: fixture.directory)
    let access = try NativeExportAccess(record: record)
    let rendering = try NativeExportPublication.prepare(
      record.items[0], record: record, access: access)
    let prepared = try NativeExportPublication.render(rendering, record: record, access: access)
    try Data("changed".utf8).write(to: try XCTUnwrap(prepared.staging))
    XCTAssertThrowsError(
      try NativeExportPublication.prepare(prepared, record: record, access: access))
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
  }
}

actor NativeExportTestFence {
  private var reached = false
  private var released = false
  private var waiting: CheckedContinuation<Void, Never>?
  private var pending: CheckedContinuation<Void, Never>?
  func wait() async {
    if reached { return }
    await withCheckedContinuation { waiting = $0 }
  }
  func arrive() async {
    reached = true
    waiting?.resume()
    waiting = nil
    if released { return }
    await withCheckedContinuation { pending = $0 }
  }
  func release() {
    released = true
    pending?.resume()
    pending = nil
  }
}
