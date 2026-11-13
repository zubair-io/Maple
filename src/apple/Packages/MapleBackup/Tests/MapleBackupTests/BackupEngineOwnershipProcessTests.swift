// Tests/MapleBackupTests/BackupEngineOwnershipProcessTests.swift
//
// #4875: the app and the backup helper are separate processes on one SQLite
// state DB. Each second host here is this test bundle relaunched by the
// xctest runner into `testSecondHostProcess`, which does what both real hosts
// do on start: take `BackupEngineLock`, then `rehydrate` the shared DB.
import XCTest

@testable import MapleBackup

final class BackupEngineOwnershipProcessTests: XCTestCase {
  private static let rootKey = "MAPLE_BACKUP_TEST_HOST_ROOT"
  private static let nameKey = "MAPLE_BACKUP_TEST_HOST_NAME"
  private static let cancelKey = "MAPLE_BACKUP_TEST_HOST_CANCEL_AFTER_MS"

  private let inFlight = BackupTaskID(deviceId: "device", phassetLocalId: "in-flight")
  private let queued = BackupTaskID(deviceId: "device", phassetLocalId: "queued")

  private static func databaseURL(in root: URL) -> URL {
    root.appendingPathComponent("backup-state.sqlite")
  }

  private static func marker(_ name: String, _ event: String, in root: URL) -> URL {
    root.appendingPathComponent("\(name).\(event)")
  }

  func testOneEngineRehydratesAtATimeAcrossProcesses() async throws {
    let root = try makeRoot()
    let seed = try BackupStateStore(databaseURL: Self.databaseURL(in: root))
    try await seed.upsert([
      BackupTask(id: inFlight, state: .uploading, priority: .background),
      BackupTask(id: queued, state: .pending, priority: .background),
    ])

    try spawnHost("first", in: root)
    let rehydrated = try await waitFor(Self.marker("first", "rehydrated", in: root))
    XCTAssertEqual(try String(contentsOf: rehydrated, encoding: .utf8), "2")

    // An ordinary open needs no engine lock: status reads keep working.
    let reader = try BackupStateStore(databaseURL: Self.databaseURL(in: root))
    let resumed = try await reader.find(inFlight)?.state
    XCTAssertEqual(resumed, .pending, "the owner resumes an interrupted upload")
    try await reader.transition(inFlight, to: .uploading)

    try spawnHost("cancelled", in: root, cancelAfterMilliseconds: 300)
    let outcome = try await waitFor(
      Self.marker("cancelled", "cancelled", in: root),
      Self.marker("cancelled", "rehydrated", in: root))
    XCTAssertEqual(
      outcome.pathExtension, "cancelled",
      "a host rehydrated while another owned the state DB instead of waiting until cancelled")

    try spawnHost("successor", in: root)
    _ = try await waitFor(Self.marker("successor", "waiting", in: root))
    try await Task.sleep(for: .milliseconds(800))
    XCTAssertFalse(
      exists(Self.marker("successor", "rehydrated", in: root)),
      "a second engine rehydrated while the first still owned the state DB")
    let live = try await reader.tasks(in: .uploading).map(\.id)
    XCTAssertEqual(live, [inFlight], "a waiting host reset the owner's live upload")

    FileManager.default.createFile(
      atPath: Self.marker("first", "release", in: root).path, contents: nil)
    _ = try await waitFor(Self.marker("first", "released", in: root))
    let successorCount = try await waitFor(Self.marker("successor", "rehydrated", in: root))
    XCTAssertEqual(try String(contentsOf: successorCount, encoding: .utf8), "2")
    let takenOver = try await reader.find(inFlight)?.state
    XCTAssertEqual(takenOver, .pending, "the successor resumes once the owner releases")
    FileManager.default.createFile(
      atPath: Self.marker("successor", "release", in: root).path, contents: nil)
    _ = try await waitFor(Self.marker("successor", "released", in: root))
  }

  /// Body of each spawned second host; does nothing in an ordinary run.
  func testSecondHostProcess() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let rootPath = environment[Self.rootKey], let name = environment[Self.nameKey] else {
      return
    }
    let root = URL(fileURLWithPath: rootPath)
    let touch = { (event: String) in
      FileManager.default.createFile(
        atPath: Self.marker(name, event, in: root).path, contents: nil)
    }
    let wait = Task {
      try await BackupEngineLock.acquireWhenFree(in: root, pollInterval: .milliseconds(50))
    }
    touch("waiting")
    if let delay = environment[Self.cancelKey].flatMap(Int.init) {
      try await Task.sleep(for: .milliseconds(delay))
      wait.cancel()
    }
    let lock: BackupEngineLock
    do {
      lock = try await wait.value
    } catch is CancellationError {
      touch("cancelled")
      return
    }
    defer {
      lock.release()
      touch("released")
    }
    let state = try BackupStateStore(databaseURL: Self.databaseURL(in: root))
    let count = try await state.rehydrate(into: InProcessBackupQueue())
    try Data("\(count)".utf8).write(
      to: Self.marker(name, "rehydrated", in: root), options: .atomic)
    // An orphaned host (the parent crashed) must not hold the lock forever.
    let deadline = ContinuousClock.now + .seconds(60)
    while !exists(Self.marker(name, "release", in: root)), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(50))
    }
  }

  private func spawnHost(
    _ name: String, in root: URL, cancelAfterMilliseconds: Int? = nil
  ) throws {
    let runner = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
    guard runner.lastPathComponent == "xctest" else {
      throw XCTSkip("a second host needs the xctest runner to relaunch this bundle")
    }
    let process = Process()
    process.executableURL = runner
    process.arguments = [
      "-XCTest", "MapleBackupTests.BackupEngineOwnershipProcessTests/testSecondHostProcess",
      Bundle(for: Self.self).bundlePath,
    ]
    let hostEnvironment =
      [Self.rootKey: root.path, Self.nameKey: name]
      .merging(cancelAfterMilliseconds.map { [Self.cancelKey: "\($0)"] } ?? [:]) { $1 }
    // Xcode's session variables would make the child run the whole test plan.
    process.environment = ProcessInfo.processInfo.environment
      .filter { !$0.key.hasPrefix("XCTest") }
      .merging(hostEnvironment) { $1 }
    let log = Self.marker(name, "log", in: root)
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let output = try FileHandle(forWritingTo: log)
    process.standardOutput = output
    process.standardError = output
    try process.run()
    try output.close()
    addTeardownBlock { if process.isRunning { process.terminate() } }
  }

  /// The first of `markers` to appear.
  private func waitFor(_ markers: URL..., timeout: Duration = .seconds(30)) async throws -> URL {
    let deadline = ContinuousClock.now + timeout
    while true {
      if let found = markers.first(where: exists) { return found }
      guard ContinuousClock.now < deadline else {
        let names = markers.map(\.lastPathComponent).joined(separator: " or ")
        XCTFail("timed out waiting for \(names)\n\(hostLogs(in: markers[0]))")
        throw CancellationError()
      }
      try await Task.sleep(for: .milliseconds(50))
    }
  }

  private func hostLogs(in marker: URL) -> String {
    let root = marker.deletingLastPathComponent()
    let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
    return names.filter { $0.hasSuffix(".log") }.sorted()
      .map { name in
        let log = try? String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
        return "\(name):\n\(log ?? "")"
      }
      .joined(separator: "\n")
  }

  private func exists(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.path)
  }

  private func makeRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("engine-ownership-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    return root
  }
}
