// CloudSourceThumbVersionTests.swift — folder-grid thumbs carry the listing's
// `thumbVersion` as `?v=`, and keep today's URL when the server sends none (#6013).

import XCTest

@testable import MapleCore

final class CloudSourceThumbVersionTests: XCTestCase {

  private let libPath = "/srv/photos/Library"
  private let server = URL(string: "https://x")!

  private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var urls: [URL] = []
    private var images = ""
    func append(_ url: URL) { lock.withLock { urls.append(url) } }
    var listingImages: String {
      get { lock.withLock { images } }
      set { lock.withLock { images = newValue } }
    }
    var thumbURLs: [URL] { lock.withLock { urls.filter { $0.path.hasPrefix("/api/thumb/") } } }
  }

  private func source(listingImages: String, recorder: Recorder) -> CloudSource {
    let libPath = self.libPath
    recorder.listingImages = listingImages
    let session = URLSession.stubbedSequence { req in
      recorder.append(req.url!)
      let body: String
      let type: String
      switch req.url?.path {
      case "/api/folders":
        body = """
          [{"id":"f1","slug":"library","path":"\(libPath)","label":"Library",
            "last_scan":null,"file_count":2,"created_at":"2026-01-01T00:00:00Z"}]
          """
        type = "application/json"
      case "/api/folder/library":
        body = """
          {"path":"\(libPath)","parentPath":null,"folders":[],"images":[\(recorder.listingImages)]}
          """
        type = "application/json"
      default:
        body = "AVIF"
        type = "image/avif"
      }
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": type])!
      return (Data(body.utf8), resp)
    }
    return CloudSource(
      server: server, folderID: "f1", libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  private func image(_ name: String, version: String?) -> String {
    let versionField = version.map { #","thumbVersion":"\#($0)""# } ?? ""
    return """
      {"name":"\(name)","path":"\(libPath)/\(name)","mtime":"2026-01-01T00:00:00Z",\
      "size":1024,"ext":"dng","exif":null\(versionField)}
      """
  }

  func testListedThumbVersionIsSentAsV() async throws {
    let recorder = Recorder()
    let cloud = source(
      listingImages: image("a.dng", version: "m1k-2s") + "," + image("b.dng", version: nil),
      recorder: recorder)

    let refs = try await cloud.images()
    for ref in refs { _ = try await cloud.thumb(for: ref) }

    XCTAssertEqual(
      recorder.thumbURLs.map(\.absoluteString),
      ["https://x/api/thumb/library/a.dng?v=m1k-2s", "https://x/api/thumb/library/b.dng"])
  }

  func testRelistingWithoutAVersionDropsTheOldOne() async throws {
    let recorder = Recorder()
    let cloud = source(listingImages: image("a.dng", version: "m1k-2s"), recorder: recorder)
    _ = try await cloud.images()
    recorder.listingImages = image("a.dng", version: nil)
    _ = try await cloud.images()

    _ = try await cloud.thumb(for: ImageRef(id: "fs:\(libPath)/a.dng", displayName: "a.dng"))

    XCTAssertNil(recorder.thumbURLs.last?.query)
  }

  func testMapEmptiedAtItsLimitLeavesAnOlderFolderOnTheUnversionedURL() async throws {
    let recorder = Recorder()
    let cloud = source(listingImages: image("a.dng", version: "m1k-2s"), recorder: recorder)
    _ = try await cloud.images()
    recorder.listingImages = (0..<CloudSource.thumbVersionLimit)
      .map { image("n\($0).dng", version: "v\($0)") }
      .joined(separator: ",")
    _ = try await cloud.images()

    _ = try await cloud.thumb(for: ImageRef(id: "fs:\(libPath)/a.dng", displayName: "a.dng"))
    XCTAssertNil(recorder.thumbURLs.last?.query)
    _ = try await cloud.thumb(for: ImageRef(id: "fs:\(libPath)/n7.dng", displayName: "n7.dng"))
    XCTAssertEqual(recorder.thumbURLs.last?.query, "v=v7")
  }

  func testThumbBeforeAnyListingKeepsTheUnversionedURL() async throws {
    let recorder = Recorder()
    let cloud = source(listingImages: image("a.dng", version: "m1k-2s"), recorder: recorder)

    _ = try await cloud.thumb(for: ImageRef(id: "fs:\(libPath)/a.dng", displayName: "a.dng"))

    XCTAssertNil(recorder.thumbURLs.last?.query)
  }
}
