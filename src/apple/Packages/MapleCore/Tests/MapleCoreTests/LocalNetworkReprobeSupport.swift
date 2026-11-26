import XCTest

@testable import MapleCloudKit

actor SleepGate {
  private var waiters: [Int: (duration: Duration, continuation: CheckedContinuation<Void, Error>)] =
    [:]
  private var nextID = 0
  private var started: [Duration: Int] = [:]
  private(set) var cancelledCount: [Duration: Int] = [:]

  func sleep(_ duration: Duration) async throws {
    let id = nextID
    nextID += 1
    started[duration, default: 0] += 1
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        waiters[id] = (duration, continuation)
        if Task.isCancelled { cancel(id) }
      }
    } onCancel: {
      Task { await self.cancel(id) }
    }
  }

  private func cancel(_ id: Int) {
    guard let waiter = waiters.removeValue(forKey: id) else { return }
    cancelledCount[waiter.duration, default: 0] += 1
    waiter.continuation.resume(throwing: CancellationError())
  }

  func release(_ duration: Duration) {
    for (id, waiter) in waiters where waiter.duration == duration {
      waiters.removeValue(forKey: id)
      waiter.continuation.resume()
    }
  }

  func startedCount(_ duration: Duration) -> Int { started[duration, default: 0] }

  func waitForCancelled(_ count: Int, of duration: Duration) async -> Bool {
    await pollUntil { self.cancelledCount[duration, default: 0] >= count }
  }

  func waitForStarted(_ count: Int, of duration: Duration) async -> Bool {
    await pollUntil { self.startedCount(duration) >= count }
  }
}

actor StatusGate {
  private var waiting: [Int: CheckedContinuation<URL, Never>] = [:]
  private var hosts: [Int] = []
  private(set) var calls = 0
  private var callsByHost: [String: Int] = [:]

  func provide(for identity: URL) async -> (effectiveURL: URL, status: LocalNetworkStatus) {
    calls += 1
    callsByHost[identity.host ?? "", default: 0] += 1
    let id = calls
    let url = await withCheckedContinuation { waiting[id] = $0 }
    return (url, LocalNetworkStatus(localURL: url, isConnectedLocally: url != identity))
  }

  func release(call: Int, with url: URL) {
    waiting.removeValue(forKey: call)?.resume(returning: url)
  }

  func callCount(host: String) -> Int { callsByHost[host, default: 0] }

  func waitForCalls(_ count: Int) async -> Bool {
    await pollUntil { self.calls >= count }
  }

  func releaseEverything(with url: URL) {
    let current = waiting
    waiting = [:]
    for continuation in current.values { continuation.resume(returning: url) }
  }
}
