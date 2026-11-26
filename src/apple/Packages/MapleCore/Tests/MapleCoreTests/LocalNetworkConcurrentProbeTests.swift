import XCTest

@testable import MapleCloudKit
@testable import MapleCore

private actor ProbeBench {
  private(set) var now: TimeInterval = 0
  private(set) var starts: [(host: String, at: TimeInterval)] = []
  private(set) var cancelled: Set<String> = []
  private var waiting: [String: CheckedContinuation<Bool, Never>] = [:]
  private var scripted: [String: (result: Bool, at: TimeInterval)] = [:]

  func run(_ endpoint: LocalHttpsEndpoint) async -> Bool {
    starts.append((endpoint.ip, now))
    if let early = scripted.removeValue(forKey: endpoint.ip) {
      now = early.at
      return early.result
    }
    return await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        waiting[endpoint.ip] = continuation
        if Task.isCancelled { cancel(endpoint.ip) }
      }
    } onCancel: {
      Task { await self.cancel(endpoint.ip) }
    }
  }

  private func cancel(_ host: String) {
    cancelled.insert(host)
    waiting.removeValue(forKey: host)?.resume(returning: false)
  }

  func finish(_ host: String, _ result: Bool, at time: TimeInterval) {
    guard let continuation = waiting.removeValue(forKey: host) else {
      scripted[host] = (result, time)
      return
    }
    now = time
    continuation.resume(returning: result)
  }

  func releaseEverything() {
    let current = waiting
    waiting = [:]
    for continuation in current.values { continuation.resume(returning: false) }
  }

  func waitForStarts(_ count: Int) async -> Bool {
    await Self.poll { self.starts.count >= count }
  }

  func waitForCancelled(_ hosts: Set<String>) async -> Bool {
    await Self.poll { self.cancelled.isSuperset(of: hosts) }
  }

  private static func poll(_ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + .seconds(5)
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(2))
    }
    return false
  }
}

private final class LockedBox<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value

  init(_ value: Value) { stored = value }

  var value: Value { lock.withLock { stored } }

  func mutate(_ change: (inout Value) -> Void) { lock.withLock { change(&stored) } }
}

final class LocalNetworkConcurrentProbeTests: XCTestCase {
  private let hostname = LocalHttpsEndpoint(ip: "local.example.com", port: 3443, scheme: "https")
  private let address = LocalHttpsEndpoint(ip: "192.168.1.42", port: 3000, scheme: "http")
  private let identity = URL(string: "http://public.example.com")!

  private func serialOracle(
    _ endpoints: [LocalHttpsEndpoint], probe: LocalNetworkResolving.CandidateProbe
  ) async -> LocalHttpsEndpoint? {
    for endpoint in endpoints where await probe(endpoint) { return endpoint }
    return nil
  }

  private func startConcurrent(_ bench: ProbeBench) -> Task<LocalHttpsEndpoint?, Never> {
    Task { [hostname, address] in
      await LocalNetworkResolving.firstPreferredSuccess(of: [hostname, address]) {
        await bench.run($0)
      }
    }
  }

  func test_bothCandidatesUnreachable_costsTheLongerTimeoutNotTheSum() async {
    let serialBench = ProbeBench()
    let serial = Task { [hostname, address] in
      await self.serialOracle([hostname, address]) { await serialBench.run($0) }
    }
    let serialFirstStarted = await serialBench.waitForStarts(1)
    XCTAssertTrue(serialFirstStarted)
    await serialBench.finish(hostname.ip, false, at: 1.5)
    let serialSecondStarted = await serialBench.waitForStarts(2)
    XCTAssertTrue(serialSecondStarted)
    let serialSecondStart = await serialBench.starts[1].at
    await serialBench.finish(address.ip, false, at: 3.0)
    let serialResult = await serial.value
    let serialTotal = await serialBench.now

    let bench = ProbeBench()
    let concurrent = startConcurrent(bench)
    let bothStarted = await bench.waitForStarts(2)
    XCTAssertTrue(bothStarted)
    let startTimes = await bench.starts.map(\.at)
    await bench.finish(hostname.ip, false, at: 1.5)
    await bench.finish(address.ip, false, at: 1.5)
    let result = await concurrent.value
    let total = await bench.now

    XCTAssertNil(serialResult)
    XCTAssertNil(result)
    XCTAssertEqual(serialSecondStart, 1.5, "serial: probe 2 starts when probe 1 gives up")
    XCTAssertEqual(serialTotal, 3.0, "serial: the sum of the two timeouts")
    XCTAssertEqual(startTimes, [0, 0], "concurrent: both probes start together")
    XCTAssertEqual(total, 1.5, "concurrent: the longer timeout")
  }

  func test_firstFailsSecondWorks_costsTheLongerOfTheTwoNotTheSum() async {
    let serialBench = ProbeBench()
    let serial = Task { [hostname, address] in
      await self.serialOracle([hostname, address]) { await serialBench.run($0) }
    }
    let serialFirstStarted = await serialBench.waitForStarts(1)
    XCTAssertTrue(serialFirstStarted)
    await serialBench.finish(hostname.ip, false, at: 1.5)
    let serialSecondStarted = await serialBench.waitForStarts(2)
    XCTAssertTrue(serialSecondStarted)
    await serialBench.finish(address.ip, true, at: 1.7)
    let serialResult = await serial.value
    let serialTotal = await serialBench.now

    let bench = ProbeBench()
    let concurrent = startConcurrent(bench)
    let bothStarted = await bench.waitForStarts(2)
    XCTAssertTrue(bothStarted)
    await bench.finish(address.ip, true, at: 0.2)
    await bench.finish(hostname.ip, false, at: 1.5)
    let result = await concurrent.value
    let total = await bench.now

    XCTAssertEqual(serialResult, address)
    XCTAssertEqual(result, address, "same route as the serial probe")
    XCTAssertEqual(serialTotal, 1.7, accuracy: 1e-9)
    XCTAssertEqual(total, 1.5, accuracy: 1e-9)
  }

  func test_firstPreferenceWinsEvenWhenTheSecondAnswersSooner() async {
    let bench = ProbeBench()
    let concurrent = startConcurrent(bench)
    let bothStarted = await bench.waitForStarts(2)
    XCTAssertTrue(bothStarted)
    await bench.finish(address.ip, true, at: 0.1)
    await bench.finish(hostname.ip, true, at: 0.9)
    let result = await concurrent.value
    XCTAssertEqual(result, hostname)
  }

  func test_losingProbeIsCancelledOnceTheFirstPreferenceSucceeds() async {
    let bench = ProbeBench()
    let concurrent = startConcurrent(bench)
    let bothStarted = await bench.waitForStarts(2)
    XCTAssertTrue(bothStarted)
    await bench.finish(hostname.ip, true, at: 0.3)
    let result = await concurrent.value
    let loserCancelled = await bench.waitForCancelled([address.ip])
    XCTAssertTrue(loserCancelled)
    await bench.releaseEverything()
    XCTAssertEqual(result, hostname)
    let cancelled = await bench.cancelled
    XCTAssertEqual(cancelled, [address.ip])
  }

  func test_cancellingTheResolutionCancelsBothProbes() async {
    let bench = ProbeBench()
    let concurrent = startConcurrent(bench)
    let bothStarted = await bench.waitForStarts(2)
    XCTAssertTrue(bothStarted)
    concurrent.cancel()
    let bothCancelled = await bench.waitForCancelled([hostname.ip, address.ip])
    XCTAssertTrue(bothCancelled)
    await bench.releaseEverything()
    let result = await concurrent.value
    XCTAssertNil(result)
  }

  func test_httpsIdentityNeverProbesOrChoosesThePlainHTTPCandidate() async {
    let body =
      #"{"available":true,"ip":"192.168.1.42","port":3000,"scheme":"http","https":{"ip":"local.example.com","port":3443,"scheme":"https"}}"#
    let session = URLSession.stubbedSequence { req in
      (
        Data(body.utf8),
        HTTPURLResponse(
          url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!
      )
    }
    let probed = LockedBox<[String]>([])
    let result = await LocalNetworkResolving.resolveStatus(
      identity: URL(string: "https://public.example.com")!, session: session
    ) { endpoint in
      probed.mutate { $0.append(endpoint.scheme) }
      return endpoint.scheme == "http"
    }
    XCTAssertEqual(result.effectiveURL, URL(string: "https://public.example.com")!)
    XCTAssertFalse(result.status.isConnectedLocally)
    XCTAssertEqual(probed.value, ["https"])
  }

  func test_httpIdentityStillPrefersHostnameOverAddress() async {
    let body =
      #"{"available":true,"ip":"192.168.1.42","port":3000,"scheme":"http","https":{"ip":"local.example.com","port":3443,"scheme":"https"}}"#
    let session = URLSession.stubbedSequence { req in
      (
        Data(body.utf8),
        HTTPURLResponse(
          url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!
      )
    }
    let result = await LocalNetworkResolving.resolveStatus(identity: identity, session: session) {
      _ in true
    }
    XCTAssertEqual(result.effectiveURL, URL(string: "https://local.example.com:3443"))
  }
}
