// ImportsClientTests.swift
//
// HTTP-level wiring for `ImportsClient` (#2773) — endpoint paths, query
// parameters, and request bodies. The one with real risk is `status(id:)`:
// it must hit `?summary=1` specifically, since that's what keeps progress
// polling from re-transferring a large import's whole `files` array every
// 1.5s.

import XCTest

@testable import MapleCore

final class ImportsClientTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> ImportsClient {
    ImportsClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  private func jsonResponse(_ req: URLRequest, _ body: String, status: Int = 200)
    -> (Data, HTTPURLResponse)
  {
    let resp = HTTPURLResponse(
      url: req.url!, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    return (Data(body.utf8), resp)
  }

  // MARK: - roots / browse

  func test_roots_targetsFsRootsAndDecodesTheArray() async throws {
    let session = URLSession.stubbedSequence { req in
      self.jsonResponse(req, #"{"roots":["/","/mnt"]}"#)
    }
    let roots = try await client(session).roots()
    XCTAssertEqual(roots, ["/", "/mnt"])
  }

  func test_browse_targetsDirFastWithPathQuery() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      return self.jsonResponse(req, #"{"path":"/mnt","parent":"/","dirs":[],"images":[]}"#)
    }
    let listing = try await client(session).browse(path: "/mnt")
    XCTAssertEqual(capturedURL?.path, "/api/fs/dir-fast")
    XCTAssertEqual(capturedURL?.query, "path=/mnt")
    XCTAssertEqual(listing.path, "/mnt")
  }

  // MARK: - scan

  func test_scan_postsSourceRootAndLibraryID() async throws {
    let session = URLSession.stubbedSequence { req in
      self.jsonResponse(
        req,
        #"""
        {"source_root":"/mnt/sd","buckets":[],
         "totals":{"files":0,"images":0,"movies":0,"sidecars":0,"bytes":0}}
        """#)
    }
    _ = try await client(session).scan(sourceRoot: "/mnt/sd", libraryID: "64a1")
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/imports/scan"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(obj["source_root"] as? String, "/mnt/sd")
    XCTAssertEqual(obj["library_id"] as? String, "64a1")
  }

  func test_scan_400WhenSourceIsOutsideTheJail() async {
    let session = URLSession.stubbed(
      response: #"{"error":"Path \"/etc\" is outside MAPLE_ROOTS [/mnt]"}"#,
      contentType: "application/json", status: 400)
    do {
      _ = try await client(session).scan(sourceRoot: "/etc", libraryID: nil)
      XCTFail("expected throw on 400")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 400)
      XCTAssertTrue(error.message.contains("MAPLE_ROOTS"))
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  // MARK: - create

  func test_create_returnsTheNewImportID() async throws {
    let session = URLSession.stubbedSequence { req in
      self.jsonResponse(req, #"{"id":"64f0"}"#, status: 201)
    }
    let id = try await client(session).create(
      sourceRoot: "/mnt/sd", libraryID: "64a1", labels: ["2026/07": "Wedding"], auto: nil)
    XCTAssertEqual(id, "64f0")
  }

  func test_create_400WhenSourceIsInsideTheLibrary() async {
    let session = URLSession.stubbed(
      response:
        #"{"error":"Source folder is the target library or inside it. Pick a source outside the library."}"#,
      contentType: "application/json", status: 400)
    do {
      _ = try await client(session).create(
        sourceRoot: "/photos/2026", libraryID: "64a1", labels: nil, auto: nil)
      XCTFail("expected throw on 400")
    } catch let error as ServerAdminError {
      XCTAssertTrue(error.message.contains("inside it"))
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  // MARK: - status (progress polling)

  func test_status_requestsTheSummaryVariantSpecifically() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      return self.jsonResponse(
        req,
        #"""
        {"id":"64f0","status":"running","source_root":"/mnt/sd","library_id":"64a1",
         "library_root":"/photos","scan_pending":false,
         "progress":{"current":5,"total":10},"counts":{"copied":5,"skipped":0,"failed":0},
         "error":null,"cancel_requested":false,"created_at":"x","updated_at":"x"}
        """#)
    }
    let summary = try await client(session).status(id: "64f0")
    XCTAssertEqual(capturedURL?.path, "/api/imports/64f0")
    XCTAssertEqual(capturedURL?.query, "summary=1")
    XCTAssertEqual(summary.status, .running)
    XCTAssertEqual(summary.percent, 50)
  }

  // MARK: - cancel / retry

  func test_cancel_postsToCancelPath() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    nonisolated(unsafe) var capturedMethod: String?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      capturedMethod = req.httpMethod
      return self.jsonResponse(req, #"{"ok":true}"#)
    }
    try await client(session).cancel(id: "64f0")
    XCTAssertEqual(capturedURL?.path, "/api/imports/64f0/cancel")
    XCTAssertEqual(capturedMethod, "POST")
  }

  func test_cancel_404WhenAlreadyFinished() async {
    let session = URLSession.stubbed(
      response: #"{"error":"Import not found or already finished"}"#,
      contentType: "application/json", status: 404)
    do {
      try await client(session).cancel(id: "64f0")
      XCTFail("expected throw on 404")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 404)
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  func test_retry_postsToRetryPath() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      return self.jsonResponse(req, #"{"ok":true}"#)
    }
    try await client(session).retry(id: "64f0")
    XCTAssertEqual(capturedURL?.path, "/api/imports/64f0/retry")
  }

  func test_retry_409WhenNotRetryable() async {
    let session = URLSession.stubbed(
      response: #"{"error":"Import not found or not in a retryable state"}"#,
      contentType: "application/json", status: 409)
    do {
      try await client(session).retry(id: "64f0")
      XCTFail("expected throw on 409")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 409)
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  // MARK: - libraries

  func test_libraries_decodesCloudFolderArray() async throws {
    let session = URLSession.stubbedSequence { req in
      self.jsonResponse(
        req,
        #"""
        [{"id":"64a1","slug":"main","path":"/photos","label":"Main","last_scan":null,
          "file_count":10,"created_at":"x"}]
        """#)
    }
    let libraries = try await client(session).libraries()
    XCTAssertEqual(libraries.first?.id, "64a1")
    XCTAssertEqual(libraries.first?.path, "/photos")
  }
}
