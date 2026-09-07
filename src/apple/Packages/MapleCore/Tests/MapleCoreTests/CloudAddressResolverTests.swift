// CloudAddressResolverTests.swift
//
// Absolute path → `slug:relPath` translation for the unified routes
// (#1325). Covers the pure root-matching rules (longest root, whole-segment
// boundary, slug-less libraries skipped) plus the actor's single shared
// `/api/folders` load and its refresh-on-miss behaviour against the
// stubbed transport.

import XCTest

@testable import MapleCore

final class CloudAddressResolverTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private func folder(_ id: String, path: String, slug: String?) -> CloudFolder {
    CloudFolder(id: id, path: path, label: id, slug: slug)
  }

  // MARK: - Pure resolution

  func test_resolve_picksLongestMatchingRoot() {
    let folders = [
      folder("f1", path: "/srv/photos", slug: "photos"),
      folder("f2", path: "/srv/photos/2024", slug: "2024"),
    ]
    let addr = MapleAddress.resolve(absPath: "/srv/photos/2024/Trip/a.dng", folders: folders)
    XCTAssertEqual(addr, MapleAddress(slug: "2024", relPath: "Trip/a.dng"))
  }

  func test_resolve_matchesWholeSegmentsOnly() {
    // `/srv/photos/Lib` is a textual prefix of `/srv/photos/Library/…` but
    // not an ancestor directory — it must not claim the file.
    let folders = [
      folder("f1", path: "/srv/photos/Lib", slug: "lib"),
      folder("f2", path: "/srv/photos/Library", slug: "library"),
    ]
    let addr = MapleAddress.resolve(absPath: "/srv/photos/Library/a.dng", folders: folders)
    XCTAssertEqual(addr, MapleAddress(slug: "library", relPath: "a.dng"))
  }

  func test_resolve_libraryRootItselfHasEmptyRelPath() {
    let folders = [folder("f1", path: "/srv/photos/", slug: "photos")]
    XCTAssertEqual(
      MapleAddress.resolve(absPath: "/srv/photos", folders: folders),
      MapleAddress(slug: "photos", relPath: ""))
  }

  func test_resolve_skipsLibrariesWithoutSlugAndUnrelatedPaths() {
    let folders = [
      folder("f1", path: "/srv/photos", slug: nil),
      folder("f2", path: "/srv/photos", slug: ""),
      folder("f3", path: "/mnt/nas", slug: "nas"),
    ]
    XCTAssertNil(MapleAddress.resolve(absPath: "/srv/photos/a.dng", folders: folders))
    XCTAssertNil(MapleAddress.resolve(absPath: "/tmp/a.dng", folders: folders))
  }

  func test_resolve_rootSlashLibrary() {
    let folders = [folder("f1", path: "/", slug: "root")]
    XCTAssertEqual(
      MapleAddress.resolve(absPath: "/photos/a.dng", folders: folders),
      MapleAddress(slug: "root", relPath: "photos/a.dng"))
  }

  // MARK: - URL building

  func test_apiPath_percentEncodesEachSegmentLikeEncodeURIComponent() {
    let addr = MapleAddress(slug: "2024", relPath: "Sub dir/a#b?c ü.dng")
    XCTAssertEqual(addr.apiPath(route: "thumb"), "/api/thumb/2024/Sub%20dir/a%23b%3Fc%20%C3%BC.dng")
    XCTAssertEqual(
      MapleAddress(slug: "2024", relPath: "").apiPath(route: "folder"), "/api/folder/2024")
    XCTAssertEqual(addr.string, "2024:Sub dir/a#b?c ü.dng")
  }

  func test_url_keepsServerPathPrefixAndDecodesBackToTheSameSegments() throws {
    let prefixed = URL(string: "https://x:3000/maple/")!
    let addr = MapleAddress(slug: "2024", relPath: "Sub dir/a#b.dng")
    let url = addr.url(server: prefixed, route: "preview")
    XCTAssertEqual(url.absoluteString, "https://x:3000/maple/api/preview/2024/Sub%20dir/a%23b.dng")
    // What Elysia's per-segment decodeURIComponent will see on the server.
    XCTAssertEqual(url.pathComponents.suffix(3).joined(separator: "/"), "2024/Sub dir/a#b.dng")
  }

  // MARK: - Actor: one shared /api/folders load

  private func foldersJSON(_ entries: [(slug: String?, path: String)]) -> String {
    let rows = entries.map { e -> String in
      let slug = e.slug.map { "\"slug\":\"\($0)\"," } ?? ""
      return
        "{\"id\":\"\(e.path)\",\(slug)\"path\":\"\(e.path)\",\"label\":\"\",\"last_scan\":null,\"file_count\":0,\"created_at\":\"\"}"
    }
    return "[" + rows.joined(separator: ",") + "]"
  }

  func test_address_loadsFoldersOnceAcrossConcurrentCalls() async throws {
    final class Counter: @unchecked Sendable { var folderLoads = 0 }
    let counter = Counter()
    let json = foldersJSON([(slug: "photos", path: "/srv/photos")])
    let session = URLSession.stubbedSequence { req in
      XCTAssertEqual(req.url?.path, "/api/folders")
      counter.folderLoads += 1
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let resolver = CloudAddressResolver(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let paths = (0..<8).map { "/srv/photos/a\($0).dng" }
    let results = try await withThrowingTaskGroup(of: MapleAddress.self) { group in
      for p in paths { group.addTask { try await resolver.address(forAbsPath: p) } }
      var out: [MapleAddress] = []
      for try await a in group { out.append(a) }
      return out
    }

    XCTAssertEqual(results.count, 8)
    XCTAssertTrue(results.allSatisfy { $0.slug == "photos" })
    XCTAssertEqual(counter.folderLoads, 1, "eight concurrent lookups must share ONE /api/folders load")
  }

  func test_address_unregisteredPathThrowsWithoutRefetchingAFreshList() async throws {
    final class Counter: @unchecked Sendable { var folderLoads = 0 }
    let counter = Counter()
    let json = foldersJSON([(slug: "photos", path: "/srv/photos")])
    let session = URLSession.stubbedSequence { req in
      counter.folderLoads += 1
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let resolver = CloudAddressResolver(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    do {
      _ = try await resolver.address(forAbsPath: "/tmp/outside.dng")
      XCTFail("a path under no registered library must throw")
    } catch let error as CloudAddressError {
      guard case .unregisteredPath(let p) = error else { return XCTFail("unexpected \(error)") }
      XCTAssertEqual(p, "/tmp/outside.dng")
    }
    XCTAssertEqual(counter.folderLoads, 1, "a miss against a just-loaded list must not refetch")
  }

  func test_address_missAgainstStaleListRefreshesOnce() async throws {
    final class State: @unchecked Sendable { var folderLoads = 0 }
    let state = State()
    let session = URLSession.stubbedSequence { req in
      state.folderLoads += 1
      // The library appears on the server between the first and second load.
      let json =
        state.folderLoads == 1
        ? self.foldersJSON([(slug: "photos", path: "/srv/photos")])
        : self.foldersJSON([(slug: "photos", path: "/srv/photos"), (slug: "nas", path: "/mnt/nas")])
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let resolver = CloudAddressResolver(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session),
      refreshAfter: 0)

    _ = try await resolver.address(forAbsPath: "/srv/photos/a.dng")
    let late = try await resolver.address(forAbsPath: "/mnt/nas/b.dng")

    XCTAssertEqual(late, MapleAddress(slug: "nas", relPath: "b.dng"))
    XCTAssertEqual(state.folderLoads, 2)
  }
}
