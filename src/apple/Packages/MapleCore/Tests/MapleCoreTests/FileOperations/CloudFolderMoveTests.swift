import XCTest

@testable import MapleCore

final class CloudFolderMoveTests: XCTestCase {
  func testMovePlanAndDescendantReopenUseServerPaths() throws {
    let plan = try CloudFolderMovePlan(
      root: "/photos/", source: "/photos/Trips/Iceland", destination: "/photos/Archive")
    XCTAssertEqual(plan.sourceRelativePath, "Trips/Iceland")
    XCTAssertEqual(plan.targetRelativePath, "Archive/Iceland")
    XCTAssertEqual(plan.targetPath, "/photos/Archive/Iceland")
    XCTAssertEqual(
      plan.reopenedPath(currentPath: "/photos/Trips/Iceland"), "/photos/Archive/Iceland")
    XCTAssertEqual(
      plan.reopenedPath(currentPath: "/photos/Trips/Iceland/day 1"), "/photos/Archive/Iceland/day 1"
    )
    XCTAssertNil(plan.reopenedPath(currentPath: "/photos/Trips/Iceland-more"))
    XCTAssertNil(plan.reopenedPath(currentPath: nil))
  }

  func testSameParentIsNoOpAndSlashRootIsSupported() throws {
    let same = try CloudFolderMovePlan(root: "/", source: "/Trips/Iceland", destination: "/Trips")
    XCTAssertTrue(same.isNoOp)
    let root = try CloudFolderMovePlan(root: "/", source: "/Trips/Iceland", destination: "/")
    XCTAssertEqual(root.targetRelativePath, "Iceland")
    XCTAssertEqual(root.targetPath, "/Iceland")
  }

  func testInvalidDestinationsFailBeforeNetwork() {
    for destination in [
      "/photos-extra", "/photos/Trips", "/photos/Trips/day1", "/photos/../outside",
      "/photos/.maple", "/photos//Archive", "/photos/Archive\0", "relative",
    ] {
      XCTAssertThrowsError(
        try CloudFolderMovePlan(root: "/photos", source: "/photos/Trips", destination: destination),
        destination)
    }
    for source in ["/photos", "/elsewhere/Trips", "/photos/.maple/trash", "/photos/./Trips"] {
      XCTAssertThrowsError(
        try CloudFolderMovePlan(root: "/photos", source: source, destination: "/photos/Archive"),
        source)
    }
  }

  func testFullTreeExcludesHiddenSourceAndPhysicalAliasesAndStopsCycles() async throws {
    let fixture = ListingFixture()
    let rootChildren: [[String: Any]] = [
      entry("Trips", path: "/photos/Trips", real: "/disk/Trips"),
      entry("Alias", path: "/photos/Alias", real: "/disk/Trips"),
      entry(".maple", path: "/photos/.maple", real: "/disk/.maple"),
      entry("Zulu", path: "/photos/Zulu", real: "/disk/Zulu"),
      entry("Archive", path: "/photos/Archive", real: "/disk/Archive"),
    ]
    fixture.add("/photos/Trips", real: "/disk/Trips")
    fixture.add("/photos", real: "/disk", dirs: rootChildren)
    fixture.add(
      "/photos/Archive", real: "/disk/Archive",
      dirs: [
        entry("Back", path: "/photos/Archive/Back", real: "/disk"),
        entry("Deep", path: "/photos/Archive/Deep", real: "/disk/Archive/Deep"),
      ])
    fixture.add("/photos/Archive/Back", real: "/disk", dirs: rootChildren)
    fixture.add("/photos/Archive/Deep", real: "/disk/Archive/Deep")
    fixture.add("/photos/Zulu", real: "/disk/Zulu")
    let nodes = try await CloudFolderMoveDestinations.tree(
      root: "/photos", rootName: "Photos", excluding: "/photos/Trips", client: fixture.client())
    XCTAssertEqual(
      nodes.map(\.id),
      [
        "/photos", "/photos/Archive", "/photos/Archive/Back", "/photos/Archive/Deep",
        "/photos/Zulu",
      ])
    XCTAssertEqual(nodes.map(\.depth), [0, 1, 2, 2, 1])
    XCTAssertEqual(
      nodes.map(\.parentID), [nil, "/photos", "/photos/Archive", "/photos/Archive", "/photos"])
    XCTAssertEqual(nodes.map(\.hasChildren), [true, true, false, false, false])
    XCTAssertEqual(
      fixture.requests,
      [
        "/api/folders", "/api/folder/photos/Trips", "/api/folder/photos",
        "/api/folder/photos/Archive", "/api/folder/photos/Archive/Back",
        "/api/folder/photos/Archive/Deep", "/api/folder/photos/Zulu",
      ])
  }

  func testUnavailableOrOldServerFailsRatherThanShowingPartialTree() async throws {
    let fixture = ListingFixture()
    fixture.add("/photos/Trips", real: "/disk/Trips")
    fixture.add("/photos", real: nil)
    await assertTreeFails(fixture)
  }

  func testListingCannotEscapeOrSmuggleTraversalOrDuplicateDestinations() async throws {
    for dirs in [
      [entry("Other", path: "/photos/Other", real: "/outside")],
      [entry("Other", path: "/photos/../Other", real: "/disk/Other")],
      [
        entry("Other", path: "/photos/Other", real: "/disk/Other"),
        entry("Other", path: "/photos/Other", real: "/disk/Other"),
      ],
    ] {
      let fixture = ListingFixture()
      fixture.add("/photos/Trips", real: "/disk/Trips")
      fixture.add("/photos", real: "/disk", dirs: dirs)
      await assertTreeFails(fixture)
    }
  }

  func testAChangedDirectoryFailsInsteadOfUsingStalePhysicalIdentity() async throws {
    let fixture = ListingFixture()
    fixture.add("/photos/Trips", real: "/disk/Trips")
    fixture.add(
      "/photos", real: "/disk",
      dirs: [entry("Archive", path: "/photos/Archive", real: "/disk/Archive")])
    fixture.add("/photos/Archive", real: "/disk/Trips")
    await assertTreeFails(fixture)
  }

  func testNetworkFailureDoesNotReturnPartialDestinations() async throws {
    let fixture = ListingFixture()
    fixture.add("/photos/Trips", real: "/disk/Trips")
    fixture.add(
      "/photos", real: "/disk",
      dirs: [entry("Archive", path: "/photos/Archive", real: "/disk/Archive")])
    // Missing Archive response is a real HTTP 503 from the controlled transport.
    await assertTreeFails(fixture)
  }

  func testCancelledWalkDoesNotIssueDirectoryRequests() async throws {
    let fixture = ListingFixture()
    let task = Task {
      while !Task.isCancelled { await Task.yield() }
      return try await CloudFolderMoveDestinations.tree(
        root: "/photos", rootName: "Photos", excluding: "/photos/Trips", client: fixture.client())
    }
    task.cancel()
    do {
      _ = try await task.value
      XCTFail("expected cancellation")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(fixture.requests, [])
  }

  private func assertTreeFails(_ fixture: ListingFixture) async {
    do {
      _ = try await CloudFolderMoveDestinations.tree(
        root: "/photos", rootName: "Photos", excluding: "/photos/Trips", client: fixture.client())
      XCTFail("expected a complete-tree failure")
    } catch {
      XCTAssertTrue(
        error is FileOperationError || (error as NSError).domain == "CloudFoldersClient")
    }
  }

  private func entry(_ name: String, path: String, real: String) -> [String: Any] {
    ["name": name, "path": path, "realPath": real, "mtime": "2026-01-01T00:00:00Z"]
  }
}

private final class ListingFixture: @unchecked Sendable {
  private let lock = NSLock()
  private var bodies: [String: Data] = [:]
  private var observed: [String] = []
  var requests: [String] {
    lock.lock()
    defer { lock.unlock() }
    return observed
  }

  func add(_ path: String, real: String?, dirs: [[String: Any]] = []) {
    let body: [String: Any] = [
      "path": path, "realPath": real as Any? ?? NSNull(), "parentPath": NSNull(), "folders": dirs,
      "images": [],
    ]
    let wire =
      path == "/photos"
      ? "/api/folder/photos" : "/api/folder/photos/" + String(path.dropFirst("/photos/".count))
    lock.lock()
    defer { lock.unlock() }
    bodies[wire] = try! JSONSerialization.data(withJSONObject: body)
  }

  func client() -> CloudFoldersClient {
    let server = URL(string: "https://example.test")!
    let session = URLSession.stubbedSequence { [self] request in
      lock.lock()
      defer { lock.unlock() }
      let path = request.url!.path
      observed.append(path)
      let data =
        path == "/api/folders"
        ? Data(
          #"[{"id":"f1","slug":"photos","path":"/photos","label":"Photos","last_scan":null,"file_count":0,"created_at":"2026-01-01"}]"#
            .utf8)
        : bodies[path]
      let response = HTTPURLResponse(
        url: request.url!, statusCode: data == nil ? 503 : 200, httpVersion: "HTTP/1.1",
        headerFields: nil)!
      return (data ?? Data(), response)
    }
    return CloudFoldersClient(
      server: server, httpClient: .unauthenticated(server: server, urlSession: session))
  }
}
