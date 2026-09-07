// CloudThumbClientTests.swift
//
// `CloudThumbClient` is the Timeline / Search / Map / TV / Widget thumbnail
// fetcher. Since #1325 it addresses the unified `/api/thumb/:slug/*` and
// `/api/preview/:slug/*` routes — the same URLs the web grid and the
// Cloudflare thumb Worker key on — translating the absolute path callers
// hold (`SearchAsset.abs_path`) through `CloudAddressResolver`.

import XCTest

@testable import MapleCore

final class CloudThumbClientTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private let foldersJSON = """
    [{"id":"f1","slug":"photos-2024","path":"/srv/photos/2024","label":"2024",
      "last_scan":null,"file_count":1,"created_at":"2026-01-01T00:00:00Z"}]
    """

  private func response(_ req: URLRequest, status: Int, contentType: String, body: String)
    -> (Data, HTTPURLResponse)
  {
    let resp = HTTPURLResponse(
      url: req.url!, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": contentType])!
    return (Data(body.utf8), resp)
  }

  private func client(_ session: URLSession) -> CloudThumbClient {
    CloudThumbClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  func test_thumb_fetchesUnifiedThumbRouteByAddress() async throws {
    final class Box: @unchecked Sendable { var urls: [URL] = [] }
    let box = Box()
    let session = URLSession.stubbedSequence { req in
      box.urls.append(req.url!)
      if req.url?.path == "/api/folders" {
        return self.response(req, status: 200, contentType: "application/json", body: self.foldersJSON)
      }
      return self.response(req, status: 200, contentType: "image/avif", body: "AVIF")
    }

    let bytes = try await client(session).thumb(absPath: "/srv/photos/2024/Sub dir/a#1.dng")

    XCTAssertEqual(bytes, Data("AVIF".utf8))
    XCTAssertEqual(
      box.urls.last?.absoluteString, "https://x/api/thumb/photos-2024/Sub%20dir/a%231.dng")
    XCTAssertFalse(box.urls.contains { $0.path.hasPrefix("/api/fs/") }, "no legacy /api/fs/* call")
  }

  func test_preview_fetchesUnifiedPreviewRoute() async throws {
    final class Box: @unchecked Sendable { var urls: [URL] = [] }
    let box = Box()
    let session = URLSession.stubbedSequence { req in
      box.urls.append(req.url!)
      if req.url?.path == "/api/folders" {
        return self.response(req, status: 200, contentType: "application/json", body: self.foldersJSON)
      }
      return self.response(req, status: 200, contentType: "image/avif", body: "PREVIEW")
    }

    let bytes = try await client(session).preview(absPath: "/srv/photos/2024/a.dng")

    XCTAssertEqual(bytes, Data("PREVIEW".utf8))
    XCTAssertEqual(box.urls.last?.absoluteString, "https://x/api/preview/photos-2024/a.dng")
  }

  func test_preview_202NotIndexedYetThrowsInsteadOfReturningTheJSONBody() async throws {
    let session = URLSession.stubbedSequence { req in
      if req.url?.path == "/api/folders" {
        return self.response(req, status: 200, contentType: "application/json", body: self.foldersJSON)
      }
      return self.response(
        req, status: 202, contentType: "application/json",
        body: #"{"status":"indexing","message":"Image not yet indexed; retry shortly"}"#)
    }

    do {
      _ = try await client(session).preview(absPath: "/srv/photos/2024/a.dng")
      XCTFail("a 202 'indexing' reply carries no image bytes and must throw")
    } catch {
      XCTAssertEqual((error as NSError).code, 202)
    }
  }

  func test_thumb_pathOutsideEveryLibraryThrowsWithoutAThumbRequest() async throws {
    final class Box: @unchecked Sendable { var urls: [URL] = [] }
    let box = Box()
    let session = URLSession.stubbedSequence { req in
      box.urls.append(req.url!)
      return self.response(req, status: 200, contentType: "application/json", body: self.foldersJSON)
    }

    do {
      _ = try await client(session).thumb(absPath: "/mnt/elsewhere/a.dng")
      XCTFail("expected CloudAddressError")
    } catch is CloudAddressError {
      // expected
    }
    XCTAssertEqual(box.urls.map(\.path), ["/api/folders"])
  }
}
