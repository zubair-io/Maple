// WorkersStatusTests.swift
//
// Wire shapes, the stage catalog port, and the counted-frame rule (#2768).
//
// The rule with teeth is `WorkersFeed`: the socket's first frames carry
// `counted: false` with every number zeroed, so applying one over real data
// makes a busy queue look drained. Everything else here is decoding and a
// port of workers.vm.ts.

import XCTest

@testable import MapleCore

// MARK: - Fixtures

private func stage(
  _ name: String, status: StageRunState = .running, inFlight: Int = 0, configured: Int = 4,
  pending: Int = 0, ready: Int = 0, blocked: Int = 0, dead: Int = 0, throughput: Double = 0,
  lastError: String? = nil, config: StageWorkerConfig? = nil, batchSize: Int = 8
) -> StageStatus {
  StageStatus(
    name: name, status: status, inFlight: inFlight, configured: configured, pending: pending,
    ready: ready, blocked: blocked, dead: dead, throughput: throughput, lastError: lastError,
    config: config, batchSize: batchSize)
}

final class WorkerStatusDecodingTests: XCTestCase {

  func test_decode_stageRow() throws {
    let json = """
      {"name":"thumb","status":"running","inFlight":2,"configured":4,"pending":10,
       "ready":7,"blocked":3,"dead":1,"throughput":12.5,"lastError":null,
       "config":{"concurrency":4,"maxAttempts":3,"paused":false,
       "last_seen_target_version":2},"batchSize":8}
      """
    let s = try JSONDecoder().decode(StageStatus.self, from: Data(json.utf8))
    XCTAssertEqual(s.name, "thumb")
    XCTAssertEqual(s.status, .running)
    XCTAssertEqual(s.blocked, 3)
    XCTAssertEqual(s.throughput, 12.5)
    XCTAssertNil(s.lastError)
    XCTAssertEqual(s.config?.concurrency, 4)
    XCTAssertFalse(s.config?.paused ?? true)
  }

  func test_decode_nullConfigAndLastError() throws {
    // Uncounted frames zero the counts and null the config.
    let json = """
      {"name":"meili","status":"paused","inFlight":0,"configured":1,"pending":0,
       "ready":0,"blocked":0,"dead":0,"throughput":0,"lastError":"boom",
       "config":null,"batchSize":1}
      """
    let s = try JSONDecoder().decode(StageStatus.self, from: Data(json.utf8))
    XCTAssertNil(s.config)
    XCTAssertEqual(s.lastError, "boom")
    XCTAssertEqual(s.status, .paused)
  }

  func test_decode_unknownStatusDoesNotFailThePayload() throws {
    // One new server-side state must not blank the whole table.
    let json = """
      {"name":"future","status":"hibernating","inFlight":0,"configured":1,"pending":0,
       "ready":0,"blocked":0,"dead":0,"throughput":0,"lastError":null,
       "config":null,"batchSize":1}
      """
    let s = try JSONDecoder().decode(StageStatus.self, from: Data(json.utf8))
    XCTAssertEqual(s.status, .unknown)
  }

  func test_decode_payloadDefaultsDamagedToZero() throws {
    let json = #"{"stages":[]}"#
    let p = try JSONDecoder().decode(WorkersStatusPayload.self, from: Data(json.utf8))
    XCTAssertEqual(p.damaged, 0)
  }

  func test_decode_frame() throws {
    let json = """
      {"type":"workers-status","counted":true,"ts":1786737637,
       "status":{"stages":[],"damaged":3,"newlyHiddenTotal":0}}
      """
    let f = try JSONDecoder().decode(WorkersStatusFrame.self, from: Data(json.utf8))
    XCTAssertTrue(f.counted)
    XCTAssertEqual(f.status.damaged, 3)
  }
}

final class StageCatalogTests: XCTestCase {

  func test_meta_knownStageHasGroupAndDescription() {
    let meta = StageCatalog.meta(for: "describe")
    XCTAssertEqual(meta.group, .enrich)
    XCTAssertFalse(meta.description.isEmpty)
  }

  func test_meta_unknownStageFallsBackToIngest() {
    // Load-bearing: a stage registered server-side must render without an
    // Apple release.
    let meta = StageCatalog.meta(for: "brand-new-stage")
    XCTAssertEqual(meta.group, .ingest)
    XCTAssertFalse(meta.icon.isEmpty)
    XCTAssertTrue(meta.description.isEmpty)
  }

  func test_grouped_ordersIngestEnrichIndexAndKeepsEmptyGroups() {
    let grouped = StageCatalog.grouped([stage("thumb"), stage("meili")])
    XCTAssertEqual(grouped.map(\.group), [.ingest, .enrich, .index])
    XCTAssertEqual(grouped[0].rows.map(\.name), ["thumb"])
    XCTAssertTrue(grouped[1].rows.isEmpty)
    XCTAssertEqual(grouped[2].rows.map(\.name), ["meili"])
  }

  func test_grouped_unknownStageLandsInIngest() {
    let grouped = StageCatalog.grouped([stage("mystery")])
    XCTAssertEqual(grouped[0].rows.map(\.name), ["mystery"])
  }

  func test_summarize_countsStagesForStatesAndSumsJobsForCounts() {
    let summary = StageCatalog.summarize([
      stage("a", status: .running, pending: 5, dead: 1),
      stage("b", status: .running, pending: 2, dead: 0),
      stage("c", status: .paused, pending: 1, dead: 4),
      stage("d", status: .error, pending: 0, dead: 0),
    ])
    XCTAssertEqual(summary.running, 2)
    XCTAssertEqual(summary.paused, 1)
    XCTAssertEqual(summary.pending, 8)
    XCTAssertEqual(summary.dead, 5)
  }

  func test_statusLabel_coversEveryState() {
    XCTAssertEqual(StageCatalog.statusLabel(.running), "Running")
    XCTAssertEqual(StageCatalog.statusLabel(.paused), "Paused")
    XCTAssertEqual(StageCatalog.statusLabel(.error), "Error")
    XCTAssertEqual(StageCatalog.statusLabel(.starting), "Starting")
    XCTAssertEqual(StageCatalog.statusLabel(.restarting), "Restarting")
    XCTAssertEqual(StageCatalog.statusLabel(.stopped), "Stopped")
    XCTAssertEqual(StageCatalog.statusLabel(.unknown), "Unknown")
  }

  func test_pendingDetail_explainsBlockedAsUpstream() {
    XCTAssertEqual(
      StageCatalog.pendingDetail(stage("a", ready: 7)), "7 ready to run")
    let detail = StageCatalog.pendingDetail(stage("a", pending: 10, ready: 7, blocked: 3))
    XCTAssertTrue(detail.contains("blocked on an upstream stage"))
  }
}

final class WorkersFeedTests: XCTestCase {

  private func payload(pending: Int, damaged: Int = 0) -> WorkersStatusPayload {
    WorkersStatusPayload(stages: [stage("thumb", pending: pending)], damaged: damaged)
  }

  func test_uncountedFrameSeedsAnEmptyTable() {
    // The cheap first snapshot is what makes stage names appear instantly
    // instead of after the first 2s counted tick.
    var feed = WorkersFeed()
    XCTAssertTrue(feed.apply(WorkersStatusFrame(status: payload(pending: 0), counted: false)))
    XCTAssertEqual(feed.payload?.stages.count, 1)
    XCTAssertFalse(feed.hasCountedData)
  }

  func test_uncountedFrameNeverOverwritesRealCounts() {
    // The regression this type exists to prevent: a reconnect's zeroed
    // snapshot making a busy queue look drained.
    var feed = WorkersFeed()
    feed.applyFallback(payload(pending: 500))
    XCTAssertFalse(feed.apply(WorkersStatusFrame(status: payload(pending: 0), counted: false)))
    XCTAssertEqual(feed.payload?.stages.first?.pending, 500)
  }

  func test_countedFrameAlwaysWins() {
    var feed = WorkersFeed()
    feed.apply(WorkersStatusFrame(status: payload(pending: 0), counted: false))
    XCTAssertTrue(feed.apply(WorkersStatusFrame(status: payload(pending: 42), counted: true)))
    XCTAssertEqual(feed.payload?.stages.first?.pending, 42)
    XCTAssertTrue(feed.hasCountedData)
  }

  func test_lateHTTPFallbackDoesNotRewindACountedFrame() {
    // The fallback request can land after the socket has already produced
    // fresher numbers.
    var feed = WorkersFeed()
    feed.apply(WorkersStatusFrame(status: payload(pending: 42), counted: true))
    XCTAssertFalse(feed.applyFallback(payload(pending: 7)))
    XCTAssertEqual(feed.payload?.stages.first?.pending, 42)
  }

  func test_fallbackSeedsWhenNothingHasArrived() {
    var feed = WorkersFeed()
    XCTAssertTrue(feed.applyFallback(payload(pending: 7)))
    XCTAssertTrue(feed.hasCountedData)
  }

  func test_authoritativeSnapshotOverridesCountedData() {
    // The post-pause re-read must win, or the row shows the pre-action
    // state until the next broadcast tick.
    var feed = WorkersFeed()
    feed.apply(WorkersStatusFrame(status: payload(pending: 42), counted: true))
    feed.applyAuthoritative(payload(pending: 1))
    XCTAssertEqual(feed.payload?.stages.first?.pending, 1)
    XCTAssertTrue(feed.hasCountedData)
  }

  func test_authoritativeSnapshotStillBlocksLaterUncountedFrames() {
    var feed = WorkersFeed()
    feed.applyAuthoritative(payload(pending: 30))
    XCTAssertFalse(feed.apply(WorkersStatusFrame(status: payload(pending: 0), counted: false)))
    XCTAssertEqual(feed.payload?.stages.first?.pending, 30)
  }
}

final class WorkerEventsClientTests: XCTestCase {

  func test_eventsURL_upgradesScheme() {
    XCTAssertEqual(
      WorkerEventsClient.eventsURL(for: URL(string: "https://maple.example.com")!)?.absoluteString,
      "wss://maple.example.com/api/events")
    XCTAssertEqual(
      WorkerEventsClient.eventsURL(for: URL(string: "http://localhost:3000")!)?.absoluteString,
      "ws://localhost:3000/api/events")
  }

  func test_eventsURL_dropsExistingPathAndQuery() {
    let url = WorkerEventsClient.eventsURL(
      for: URL(string: "https://maple.example.com/some/path?x=1")!)
    XCTAssertEqual(url?.absoluteString, "wss://maple.example.com/api/events")
  }

  func test_eventsURL_rejectsNonHTTPSchemes() {
    XCTAssertNil(WorkerEventsClient.eventsURL(for: URL(string: "ftp://example.com")!))
  }

  func test_authFrame_shapeMatchesServerExpectation() throws {
    let text = try WorkerEventsClient.authFrame(token: "abc.def.ghi")
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    XCTAssertEqual(obj["type"] as? String, "auth")
    XCTAssertEqual(obj["token"] as? String, "abc.def.ghi")
    XCTAssertEqual(obj.keys.count, 2)
  }

  func test_backoff_firstRetryWaitsOneSecondNotTwo() {
    // Regression: the run loop used to increment its counter *before*
    // asking for a delay, so the real sequence started at 2s while a test
    // of the arithmetic in isolation still passed. Driving the sequencer
    // the way the loop drives it is the point of this test.
    var backoff = WorkerEventsClient.BackoffSequencer()
    XCTAssertEqual(backoff.nextDelay(), 1)
  }

  func test_backoff_followsScheduleThenHoldsAtFifteen() {
    var backoff = WorkerEventsClient.BackoffSequencer()
    let observed = (0..<8).map { _ in backoff.nextDelay() }
    XCTAssertEqual(observed, [1, 2, 4, 8, 15, 15, 15, 15])
  }

  func test_backoff_resetReturnsToOneSecond() {
    // A connection that succeeded and later dropped starts a fresh
    // sequence rather than continuing a stale escalation.
    var backoff = WorkerEventsClient.BackoffSequencer()
    _ = backoff.nextDelay()
    _ = backoff.nextDelay()
    backoff.reset()
    XCTAssertEqual(backoff.nextDelay(), 1)
  }

  func test_readTimeout_leavesRoomForSeveralMissedBroadcastTicks() {
    // The server broadcasts every ~2s (COUNT_INTERVAL_MS). The watchdog
    // must be long enough to ride out jitter and short enough that a
    // silently-dropped connection doesn't leave stale counts labelled
    // "live" — the failure mode iOS produces when Wi-Fi goes away without
    // a TCP FIN.
    XCTAssertGreaterThanOrEqual(WorkerEventsClient.readTimeout, .seconds(10))
    XCTAssertLessThanOrEqual(WorkerEventsClient.readTimeout, .seconds(30))
  }

  func test_updateEquatabilityDistinguishesConnectionStates() {
    // The view switches on these; conflating them is what made the
    // disconnect banner unreachable.
    XCTAssertNotEqual(WorkerEventsUpdate.connected, WorkerEventsUpdate.disconnected)
  }
}

final class WorkersAdminClientTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> WorkersAdminClient {
    WorkersAdminClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  func test_status_decodesStages() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      let json = """
        {"stages":[{"name":"thumb","status":"running","inFlight":1,"configured":4,
         "pending":9,"ready":9,"blocked":0,"dead":0,"throughput":3,"lastError":null,
         "config":null,"batchSize":8}],"damaged":2,"newlyHiddenTotal":0}
        """
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let payload = try await client(session).status()
    XCTAssertEqual(capturedURL?.path, "/api/workers/status")
    XCTAssertEqual(payload.stages.first?.name, "thumb")
    XCTAssertEqual(payload.damaged, 2)
  }

  func test_pause_postsToStagePath() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    nonisolated(unsafe) var capturedMethod: String?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      capturedMethod = req.httpMethod
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"ok":true}"#.utf8), resp)
    }
    try await client(session).pause(stage: "face-detect")
    XCTAssertEqual(capturedURL?.path, "/api/workers/face-detect/pause")
    XCTAssertEqual(capturedMethod, "POST")
  }

  func test_resume_surfacesServerError() async {
    let session = URLSession.stubbed(
      response: #"{"error":"unknown stage"}"#, contentType: "application/json", status: 404)
    do {
      try await client(session).resume(stage: "nope")
      XCTFail("expected throw on 404")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 404)
      XCTAssertEqual(error.message, "unknown stage")
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }
}
