// WorkerTriageTests.swift
//
// Dead-job and damaged-asset wire shapes plus the triage client (#2769).
//
// The theme is nullability: the server builds these records inline from
// partial Mongo documents, so almost every field can be absent. A decoder
// that insists on them would drop exactly the rows an operator opened the
// drawer to look at.

import XCTest

@testable import MapleCloudKit
@testable import MapleCore

final class WorkerTriageDecodingTests: XCTestCase {

  func test_decode_deadJob_full() throws {
    let json = """
      {"id":"66a1","abs_path":"/lib/a.dng","last_error":"decode failed",
       "attempts":5,"processed_at":"2026-08-15T04:00:00Z"}
      """
    let job = try JSONDecoder().decode(DeadJob.self, from: Data(json.utf8))
    XCTAssertEqual(job.id, "66a1")
    XCTAssertEqual(job.absPath, "/lib/a.dng")
    XCTAssertEqual(job.lastError, "decode failed")
    XCTAssertEqual(job.attempts, 5)
  }

  func test_decode_deadJob_allOptionalsNull() throws {
    // A stage can die without recording an error or an attempt count.
    let json = """
      {"id":"66a2","abs_path":null,"last_error":null,"attempts":null,"processed_at":null}
      """
    let job = try JSONDecoder().decode(DeadJob.self, from: Data(json.utf8))
    XCTAssertEqual(job.id, "66a2")
    XCTAssertNil(job.absPath)
    XCTAssertNil(job.lastError)
    XCTAssertNil(job.attempts)
  }

  func test_decode_damagedAsset_full() throws {
    let json = """
      {"id":"66b1","maple_id":"mpl_1","abs_path":"/lib/b.cr2","stage":"exif",
       "reason":"unreadable header","since":"2026-08-14T09:00:00Z"}
      """
    let asset = try JSONDecoder().decode(DamagedAsset.self, from: Data(json.utf8))
    XCTAssertEqual(asset.mapleID, "mpl_1")
    XCTAssertEqual(asset.stage, "exif")
    XCTAssertEqual(asset.reason, "unreadable header")
  }

  func test_decode_damagedAsset_tagWithoutDetails() throws {
    // The damaged tag predates the fields describing it, so old rows
    // arrive with everything but an id missing.
    let json = """
      {"id":"66b2","maple_id":null,"abs_path":null,"stage":null,"reason":null,"since":null}
      """
    let asset = try JSONDecoder().decode(DamagedAsset.self, from: Data(json.utf8))
    XCTAssertEqual(asset.id, "66b2")
    XCTAssertNil(asset.stage)
  }
}

final class WorkerTriageClientTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> WorkersAdminClient {
    WorkersAdminClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  private func ok(_ req: URLRequest, _ body: String) -> (Data, HTTPURLResponse) {
    let resp = HTTPURLResponse(
      url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    return (Data(body.utf8), resp)
  }

  func test_deadJobs_targetsStagePathWithLimit() async throws {
    nonisolated(unsafe) var captured: URL?
    let session = URLSession.stubbedSequence { req in
      captured = req.url
      return self.ok(req, #"{"items":[{"id":"1","abs_path":"/a","last_error":null,"attempts":3,"processed_at":null}]}"#)
    }
    let jobs = try await client(session).deadJobs(stage: "face-detect", limit: 25)
    XCTAssertEqual(captured?.path, "/api/workers/face-detect/dead")
    XCTAssertEqual(
      URLComponents(url: captured!, resolvingAgainstBaseURL: false)?
        .queryItems?.first(where: { $0.name == "limit" })?.value, "25")
    XCTAssertEqual(jobs.count, 1)
    XCTAssertEqual(jobs.first?.attempts, 3)
  }

  func test_damagedAssets_isNotStageScoped() async throws {
    nonisolated(unsafe) var captured: URL?
    let session = URLSession.stubbedSequence { req in
      captured = req.url
      return self.ok(req, #"{"items":[]}"#)
    }
    _ = try await client(session).damagedAssets()
    XCTAssertEqual(captured?.path, "/api/workers/damaged")
  }

  func test_retryDead_reportsServerResetCount() async throws {
    let session = URLSession.stubbedSequence { req in
      self.ok(req, #"{"ok":true,"reset":7}"#)
    }
    let result = try await client(session).retryDead(stage: "thumb")
    XCTAssertEqual(result.affected, 7)
  }

  func test_clearDamaged_withIdSendsThatId() async throws {
    let session = URLSession.stubbedSequence { req in
      self.ok(req, #"{"ok":true,"cleared":1}"#)
    }
    let result = try await client(session).clearDamaged(id: "66b1")
    let body = try XCTUnwrap(
      URLProtocolStub.capturedBodies["https://x/api/workers/damaged/clear"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(obj["id"] as? String, "66b1")
    XCTAssertEqual(result.affected, 1)
  }

  func test_clearDamaged_withoutIdSendsEmptyObjectNotEmptyBody() async throws {
    // The route parses JSON; a zero-length body is not valid JSON, and a
    // missing id is what tells the server to clear everything.
    let session = URLSession.stubbedSequence { req in
      self.ok(req, #"{"ok":true,"cleared":42}"#)
    }
    let result = try await client(session).clearDamaged(id: nil)
    let body = try XCTUnwrap(
      URLProtocolStub.capturedBodies["https://x/api/workers/damaged/clear"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertTrue(obj.isEmpty)
    XCTAssertEqual(result.affected, 42)
  }

  func test_deadJobs_unknownStageSurfaces404() async {
    let session = URLSession.stubbed(
      response: #"{"error":"unknown stage: nope"}"#, contentType: "application/json", status: 404)
    do {
      _ = try await client(session).deadJobs(stage: "nope")
      XCTFail("expected throw on 404")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 404)
      XCTAssertTrue(error.message.contains("unknown stage"))
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }
}
