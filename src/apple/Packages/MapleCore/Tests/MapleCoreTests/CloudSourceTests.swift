// CloudSourceTests.swift
import XCTest
@testable import MapleCore

final class CloudSourceTests: XCTestCase {

  private let libPath = "/srv/photos/Library"

  // MARK: images() — calls /api/fs/dir, no auto-pagination

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

  // MARK: thumb — uses /api/fs/thumb?path=…

  func test_thumb_returnsBytesOn200() async throws {
    let server = URL(string: "https://x")!
    var lastURL: URL?
    let session = URLSession.stubbedSequence { req in
      lastURL = req.url
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                 httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "image/jpeg"])!
      return (Data("JPEGBYTES".utf8), resp)
    }
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.thumb(for: ImageRef(id: "fs:/srv/photos/Library/a.dng",
                                                    displayName: "a.dng"))
    XCTAssertEqual(data, Data("JPEGBYTES".utf8))
    XCTAssertTrue(lastURL?.absoluteString.contains("/api/fs/thumb") == true,
                  "must use /api/fs/thumb, got: \(lastURL?.absoluteString ?? "nil")")
  }

  func test_thumb_returnsNilOn404() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "not found",
                                     contentType: "text/plain",
                                     status: 404)
    let source = CloudSource(server: server, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.thumb(for: ImageRef(id: "fs:/srv/photos/Library/a.dng",
                                                    displayName: "a.dng"))
    XCTAssertNil(data)
  }

  // MARK: rawBytes — uses /api/fs/raw?path=…

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
