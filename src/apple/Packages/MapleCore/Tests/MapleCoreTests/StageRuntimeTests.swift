// StageRuntimeTests.swift — per-stage runtime knobs and the three
// stage-specific one-offs (#2770).
//
// The rule with real consequences is that `pollIntervalMs` and `batchSize`
// must never reach the wire. They were retired as knobs in #674 and the
// route 400s if either key appears, so `StageRuntimePatch` has no field for
// them — these tests pin that the encoded body stays that way.

import XCTest

@testable import MapleCloudKit
@testable import MapleCore

final class StageRuntimePatchTests: XCTestCase {

  private func encoded(_ patch: StageRuntimePatch) throws -> [String: Any] {
    let data = try JSONEncoder().encode(patch)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func test_encode_carriesOnlyTheLiveKnobs() throws {
    let obj = try encoded(StageRuntimePatch(concurrency: 4, maxAttempts: 3))
    XCTAssertEqual(obj["concurrency"] as? Int, 4)
    XCTAssertEqual(obj["maxAttempts"] as? Int, 3)
    XCTAssertFalse(obj.keys.contains("pollIntervalMs"), "retired knob would 400 the request")
    XCTAssertFalse(obj.keys.contains("batchSize"), "retired knob would 400 the request")
  }

  func test_encode_omitsAbsentFieldsRatherThanNullingThem() throws {
    // A patch with a null would be asking the server to store a null, not
    // to leave the field alone.
    let obj = try encoded(StageRuntimePatch(concurrency: 8))
    XCTAssertEqual(obj.keys.sorted(), ["concurrency"])
  }
}

final class StageRuntimeFormTests: XCTestCase {

  private func config(concurrency: Int = 4, maxAttempts: Int = 3) -> StageWorkerConfig {
    StageWorkerConfig(concurrency: concurrency, maxAttempts: maxAttempts, paused: false)
  }

  func test_seed_fromConfig() {
    let form = StageRuntimeForm.seeded(from: config(concurrency: 6, maxAttempts: 5))
    XCTAssertEqual(form.concurrency, "6")
    XCTAssertEqual(form.maxAttempts, "5")
  }

  func test_seed_withNoConfigLeavesFieldsBlank() {
    // A stage with no stored config shouldn't display invented defaults as
    // though the server had chosen them.
    let form = StageRuntimeForm.seeded(from: nil)
    XCTAssertEqual(form.concurrency, "")
    XCTAssertEqual(form.maxAttempts, "")
  }

  func test_patch_clampsToServerBounds() {
    var form = StageRuntimeForm(concurrency: "500", maxAttempts: "99")
    XCTAssertEqual(form.patch()?.concurrency, 100)
    XCTAssertEqual(form.patch()?.maxAttempts, 20)

    form = StageRuntimeForm(concurrency: "0", maxAttempts: "0")
    XCTAssertEqual(form.patch()?.concurrency, 1)
    XCTAssertEqual(form.patch()?.maxAttempts, 1)
  }

  func test_patch_nilWhenNothingUsableWasTyped() {
    XCTAssertNil(StageRuntimeForm(concurrency: "", maxAttempts: "").patch())
    XCTAssertNil(StageRuntimeForm(concurrency: "abc", maxAttempts: " ").patch())
  }

  func test_patch_sendsOnlyTheFieldThatWasFilled() {
    let patch = StageRuntimeForm(concurrency: "7", maxAttempts: "").patch()
    XCTAssertEqual(patch?.concurrency, 7)
    XCTAssertNil(patch?.maxAttempts)
  }

  func test_isDirty_falseWhenMatchingTheServer() {
    let form = StageRuntimeForm.seeded(from: config())
    XCTAssertFalse(form.isDirty(comparedTo: config()))
    XCTAssertTrue(
      StageRuntimeForm(concurrency: "9", maxAttempts: "3").isDirty(comparedTo: config()))
  }
}

final class WorkerRuntimeDecodingTests: XCTestCase {

  func test_decode_performanceWithPool() throws {
    let json = """
      {"ffi_workers":4,"source":"db","min":1,"max":16,
       "pool":{"target":4,"spawned":4,"busy":1,"queued":0}}
      """
    let perf = try JSONDecoder().decode(WorkerPerformance.self, from: Data(json.utf8))
    XCTAssertEqual(perf.ffiWorkers, 4)
    XCTAssertEqual(perf.source, "db")
    XCTAssertEqual(perf.pool?.busy, 1)
  }

  func test_decode_performanceWithoutOptionalFields() throws {
    let json = #"{"ffi_workers":8}"#
    let perf = try JSONDecoder().decode(WorkerPerformance.self, from: Data(json.utf8))
    XCTAssertEqual(perf.min, 1)
    XCTAssertEqual(perf.max, 16)
    XCTAssertNil(perf.pool)
  }

  func test_decode_migrationWithSparseFields() throws {
    // Migration docs predate several of these fields.
    let json = #"{"id":"backfill-x"}"#
    let m = try JSONDecoder().decode(MigrationInfo.self, from: Data(json.utf8))
    XCTAssertEqual(m.id, "backfill-x")
    XCTAssertEqual(m.title, "backfill-x", "title falls back to the id")
    XCTAssertEqual(m.status, "idle")
    XCTAssertFalse(m.enabled)
  }

  func test_encode_migrationCommandsAreMutuallyExclusive() throws {
    let enable = try JSONSerialization.jsonObject(
      with: JSONEncoder().encode(MigrationCommand.setEnabled(true))) as? [String: Any]
    XCTAssertEqual(enable?["enabled"] as? Bool, true)
    XCTAssertFalse(enable?.keys.contains("reset") ?? true)

    let reset = try JSONSerialization.jsonObject(
      with: JSONEncoder().encode(MigrationCommand.reset)) as? [String: Any]
    XCTAssertEqual(reset?["reset"] as? Bool, true)
    XCTAssertFalse(reset?.keys.contains("enabled") ?? true)
  }
}

final class WorkerRuntimeClientTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> WorkersAdminClient {
    WorkersAdminClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  func test_updateRuntime_patchesStagePathWithoutRetiredKeys() async throws {
    nonisolated(unsafe) var method: String?
    let session = URLSession.stubbedSequence { req in
      method = req.httpMethod
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (
        Data(
          #"{"ok":true,"config":{"concurrency":4,"maxAttempts":3,"paused":false,"last_seen_target_version":2}}"#
            .utf8), resp
      )
    }
    let config = try await client(session).updateRuntime(
      stage: "thumb", patch: StageRuntimePatch(concurrency: 4))
    XCTAssertEqual(method, "PATCH")
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/workers/thumb/config"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertFalse(obj.keys.contains("batchSize"))
    XCTAssertFalse(obj.keys.contains("pollIntervalMs"))
    XCTAssertEqual(config?.concurrency, 4)
  }

  func test_updateRuntime_surfacesTheRetiredKeyRejection() async {
    // If a future change ever reintroduced one of those keys, this is the
    // failure the operator would see.
    let session = URLSession.stubbed(
      response: #"{"error":"removed config keys not accepted: batchSize"}"#,
      contentType: "application/json", status: 400)
    do {
      _ = try await client(session).updateRuntime(
        stage: "thumb", patch: StageRuntimePatch(concurrency: 1))
      XCTFail("expected throw on 400")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 400)
      XCTAssertTrue(error.message.contains("removed config keys"))
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  func test_pruneWindow_roundTrip() async throws {
    let session = URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"ok":true,"hours":72}"#.utf8), resp)
    }
    let hours = try await client(session).setPruneWindowHours(72)
    XCTAssertEqual(hours, 72)
    let body = try XCTUnwrap(
      URLProtocolStub.capturedBodies["https://x/api/workers/missing-reaper/prune-window"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(obj["hours"] as? Int, 72)
  }

  func test_migrations_decodesList() async throws {
    let session = URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (
        Data(#"{"migrations":[{"id":"m1","title":"One","enabled":true,"status":"running"}]}"#.utf8),
        resp
      )
    }
    let list = try await client(session).migrations()
    XCTAssertEqual(list.first?.id, "m1")
    XCTAssertTrue(list.first?.enabled ?? false)
  }
}
