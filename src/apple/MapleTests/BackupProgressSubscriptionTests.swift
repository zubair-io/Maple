import MapleBackup
import XCTest

@testable import Maple

@MainActor
final class BackupProgressSubscriptionTests: XCTestCase {
  func testStopDuringSubscriptionDoesNotRestartProgress() async {
    let vm = BackupProgressViewModel()
    let entered = expectation(description: "subscription suspended")
    let release = DispatchSemaphore(value: 0)
    let queue = await GatedSubscriptionQueue(entered: entered, release: release)
    defer {
      release.signal()
      vm.stop()
    }
    let start = Task { await vm.start(queue: queue) }
    await fulfillment(of: [entered], timeout: 5)
    vm.stop()
    release.signal()
    await start.value
    XCTAssertFalse(vm.isRunning)
  }

  func testOlderSubscriptionCannotReplaceNewerObserver() async throws {
    let vm = BackupProgressViewModel()
    let entered = expectation(description: "old subscription suspended")
    let release = DispatchSemaphore(value: 0)
    let oldQueue = await GatedSubscriptionQueue(entered: entered, release: release)
    let newQueue = InProcessBackupQueue()
    defer {
      release.signal()
      vm.stop()
    }
    let oldStart = Task { await vm.start(queue: oldQueue) }
    await fulfillment(of: [entered], timeout: 5)
    await vm.start(queue: newQueue)
    release.signal()
    await oldStart.value
    // stop must cancel the NEW observer, rather than a stale task which
    // installed itself after the second start returned.
    vm.stop()
    await newQueue.emit(.started(.init(deviceId: "d", phassetLocalId: "new")))
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertFalse(vm.isRunning)
    XCTAssertTrue(vm.inFlight.isEmpty)
  }
}

// Hold the synchronous actor subscription at its suspension boundary while
// the main actor runs start/stop. All queue behavior delegates to the real queue.
private actor GatedSubscriptionQueue: BackupQueue {
  let queue = InProcessBackupQueue()
  let stream: AsyncStream<BackupQueueEvent>
  let entered: XCTestExpectation
  let release: DispatchSemaphore

  init(entered: XCTestExpectation, release: DispatchSemaphore) async {
    self.entered = entered
    self.release = release
    self.stream = await queue.observe()
  }

  func observe() -> AsyncStream<BackupQueueEvent> {
    entered.fulfill()
    _ = release.wait(timeout: .now() + 5)
    return stream
  }

  func enqueue(_ task: BackupTask, priority: BackupPriority) async {
    await queue.enqueue(task, priority: priority)
  }
  func cancel(_ id: BackupTaskID) async { await queue.cancel(id) }
  func dequeue() async -> BackupTask? { await queue.dequeue() }
  func snapshot() async -> [BackupTask] { await queue.snapshot() }
  func emit(_ event: BackupQueueEvent) async { await queue.emit(event) }
}
