// CloudSourceTests.swift
import XCTest
@testable import MapleCore

final class CloudSourceTests: XCTestCase {

  private let libPath = "/srv/photos/Library"

  // MARK: images() — calls /api/fs/dir (the enriched listing: video, size,
  // EXIF — `/api/folder/:slug/*` carries none of those yet), no auto-pagination

  func test_images_returnsImagesAtPathLevel() async throws {
    let server = URL(string: "https://example.test")!
    var requestCount = 0
    var lastURL: URL?
    let session = URLSession.stubbedSequence { req in
      requestCount += 1
      lastURL = req.url
      let json = Self.fsDirListingJSON(path: self.libPath, imageCount: 3)
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                 httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let refs = try await source.images()

    XCTAssertEqual(refs.count, 3)
    XCTAssertEqual(requestCount, 1, "must NOT auto-paginate")
    XCTAssertTrue(lastURL?.absoluteString.contains("/api/fs/dir") == true,
                  "must use /api/fs/dir, got: \(lastURL?.absoluteString ?? "nil")")
    XCTAssertTrue(lastURL?.absoluteString.contains("path=") == true)
    XCTAssertEqual(refs.first?.id.hasPrefix("fs:") == true, true,
                   "ImageRef.id should be prefixed `fs:` for cloud sources")
  }

  func test_navigate_changesNextListingPath() async throws {
    let server = URL(string: "https://example.test")!
    var lastURL: URL?
    let session = URLSession.stubbedSequence { req in
      lastURL = req.url
      let json = Self.fsDirListingJSON(path: "/srv/photos/Library/sub", imageCount: 1)
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                 httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    await source.navigate(to: "/srv/photos/Library/sub")
    _ = try await source.images()

    XCTAssertTrue(lastURL?.absoluteString.contains("path=/srv/photos/Library/sub") == true
               || lastURL?.absoluteString.contains("path=%2Fsrv%2Fphotos%2FLibrary%2Fsub") == true,
                  "expected path query to reflect navigate(), got: \(lastURL?.absoluteString ?? "nil")")
  }

  // MARK: thumb / preview — unified `/api/thumb|preview/:slug/*` by address (#1325)

  private final class Box: @unchecked Sendable { var values: [URL] = [] }

  /// `/api/folders` answers the address resolver translates `fs:<absPath>`
  /// ids through; every other request gets `imageStatus` + `imageBody`.
  private func stubbedAddressSession(
    imageStatus: Int, imageBody: String, urls: Box
  ) -> URLSession {
    URLSession.stubbedSequence { req in
      urls.values.append(req.url!)
      if req.url?.path == "/api/folders" {
        let json = """
          [{"id":"f1","slug":"library","path":"\(self.libPath)","label":"Library",
            "last_scan":null,"file_count":3,"created_at":"2026-01-01T00:00:00Z"}]
          """
        let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": "application/json"])!
        return (Data(json.utf8), resp)
      }
      let resp = HTTPURLResponse(url: req.url!, statusCode: imageStatus, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "image/avif"])!
      return (Data(imageBody.utf8), resp)
    }
  }

  func test_thumb_returnsBytesFromUnifiedThumbRoute() async throws {
    let server = URL(string: "https://x")!
    let urls = Box()
    let session = stubbedAddressSession(imageStatus: 200, imageBody: "AVIFBYTES", urls: urls)
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.thumb(for: ImageRef(id: "fs:/srv/photos/Library/Sub dir/a.dng",
                                                    displayName: "a.dng"))
    XCTAssertEqual(data, Data("AVIFBYTES".utf8))
    XCTAssertEqual(urls.values.last?.absoluteString,
                   "https://x/api/thumb/library/Sub%20dir/a.dng")
    XCTAssertFalse(urls.values.contains { $0.path.hasPrefix("/api/fs/") },
                   "thumbs must not touch the legacy /api/fs/* surface")
  }

  func test_thumb_returnsNilOn404() async throws {
    let server = URL(string: "https://x")!
    let session = stubbedAddressSession(imageStatus: 404, imageBody: "not found", urls: Box())
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.thumb(for: ImageRef(id: "fs:/srv/photos/Library/a.dng",
                                                    displayName: "a.dng"))
    XCTAssertNil(data)
  }

  func test_preview_usesUnifiedPreviewRoute() async throws {
    let server = URL(string: "https://x")!
    let urls = Box()
    let session = stubbedAddressSession(imageStatus: 200, imageBody: "PREVIEW", urls: urls)
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.preview(for: ImageRef(id: "fs:/srv/photos/Library/a.dng",
                                                      displayName: "a.dng"))
    XCTAssertEqual(data, Data("PREVIEW".utf8))
    XCTAssertEqual(urls.values.last?.absoluteString, "https://x/api/preview/library/a.dng")
  }

  func test_preview_returnsNilWhileServerIsStillIndexing() async throws {
    // `/api/preview` answers 202 + Retry-After until the asset is indexed;
    // that body is JSON, not pixels — the Preview screen keeps its thumbnail.
    let server = URL(string: "https://x")!
    let session = stubbedAddressSession(
      imageStatus: 202, imageBody: #"{"status":"indexing"}"#, urls: Box())
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.preview(for: ImageRef(id: "fs:/srv/photos/Library/a.dng",
                                                      displayName: "a.dng"))
    XCTAssertNil(data)
  }

  // MARK: rawBytes — deliberately still /api/fs/raw?path=… (#926 mirror failover)

  func test_rawBytes_returnsBytesOn200() async throws {
    let server = URL(string: "https://x")!
    var lastURL: URL?
    let session = URLSession.stubbedSequence { req in
      lastURL = req.url
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                 httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "application/octet-stream"])!
      return (Data("RAWBYTES".utf8), resp)
    }
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.rawBytes(for: ImageRef(id: "fs:/srv/photos/Library/a.dng",
                                                       displayName: "a.dng"))
    XCTAssertEqual(data, Data("RAWBYTES".utf8))
    // `/api/image/:slug/*` has no mirror read-failover (#926 lives in
    // `/api/fs/raw` only), so original bytes stay on the legacy route until
    // the server ports it.
    XCTAssertTrue(lastURL?.absoluteString.contains("/api/fs/raw") == true)
  }

  // MARK: writeXMP — explicit unsupported

  func test_writeXMP_throws() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "")
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let sidecar = Sidecar(model: .default, culling: CullingState())
    do {
      try await source.writeXMP(sidecar, for: ImageRef(id: "fs:/x.dng", displayName: "x.dng"))
      XCTFail("CloudSource.writeXMP should throw — XMP writes go through CloudSidecarStore")
    } catch {
      // expected — uses CloudSidecarStore for editing instead
    }
  }

  // MARK: helpers

  private static func fsDirListingJSON(path: String, imageCount: Int) -> String {
    let images = (0..<imageCount).map { i in
      """
      {"name":"a\(i).dng","path":"\(path)/a\(i).dng","mtime":"2026-01-01T00:00:00Z","size":1024,"ext":"dng","exif":null}
      """
    }.joined(separator: ",")
    return """
    {"path":"\(path)","parent":null,"dirs":[],"images":[\(images)]}
    """
  }
}
