// src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderRootPlacementTests.swift
import FileProvider
import XCTest

@testable import MapleFileProviderCore

/// #5503: photos from `2025/Sumac/0001/` showed at the top level of Maple in
/// Files. A working-set item whose library list failed to load, or whose
/// library was missing from it, was parented at `.rootContainer`, and the OS
/// keeps that parent until the item next changes.
final class FileProviderRootPlacementTests: XCTestCase {
  private static let libraryID = "69f969e0fb95bf0ea8651ad1"
  private static let library = LibraryRoot(
    id: libraryID, path: "/srv/photos/Maple", label: "Maple", fileCount: 9)
  private static let sumacFolder = NSFileProviderItemIdentifier(
    FileProviderIdentifier.folder(folderID: libraryID, relativePath: "2025/Sumac/0001").rawValue)
  private static let filenames = ["_84A9562.CR2", "_84A9562.JPG", "_84A9563.CR2"]

  private final class FetchScript: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    private let outcomes: [Result<[LibraryRoot], URLError>]
    init(_ outcomes: [Result<[LibraryRoot], URLError>]) { self.outcomes = outcomes }
    var callCount: Int { lock.withLock { calls } }
    func next() throws -> [LibraryRoot] {
      let index = lock.withLock {
        calls += 1
        return min(calls - 1, outcomes.count - 1)
      }
      return try outcomes[index].get()
    }
  }

  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }

  private func rootCache(_ fetch: @escaping LibraryRootCache.Fetcher) -> LibraryRootCache {
    LibraryRootCache(
      domainID: "placement-\(UUID().uuidString)",
      defaults: UserDefaults(suiteName: "placement-\(UUID().uuidString)")!,
      fetcher: fetch)
  }

  private func assetListJSON(folderID: String) -> Data {
    let rows = Self.filenames.enumerated().map { index, name in
      """
      {"id": "\(String(format: "%024x", index + 1))", "folder_id": "\(folderID)",
       "filename": "\(name)", "abs_path": "/srv/photos/Maple/2025/Sumac/0001/\(name)",
       "mtime": 1758412800, "rating": 0, "has_xmp": false}
      """
    }
    return Data("{\"assets\": [\(rows.joined(separator: ","))]}".utf8)
  }

  private func workingSet(session: URLSession, rootCache: LibraryRootCache) -> WorkingSetEnumerator {
    let server = URL(string: "https://x.test")!
    let catalog = RemoteCatalog(
      http: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session),
      server: server, downloadURLSession: session)
    let cursorDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("placement-\(UUID().uuidString)")
    addTeardownBlock { try? FileManager.default.removeItem(at: cursorDir) }
    return WorkingSetEnumerator(
      catalog: catalog, workingSet: WorkingSet(capacity: 100),
      cursorStore: ChangeCursorStore(directory: cursorDir), domainID: "placement",
      listCache: WorkingSetListCache(catalog: catalog), rootCache: rootCache)
  }

  private func seedSession(folderID: String) -> URLSession {
    URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (self.assetListJSON(folderID: folderID), resp)
    }
  }

  private func enumerateSeed(_ enumerator: WorkingSetEnumerator) async -> TestEnumerationObserver {
    let observer = TestEnumerationObserver()
    enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
    let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
    XCTAssertTrue(finished)
    return observer
  }

  func testSeedFailsInsteadOfParentingAtTheTopLevelWhenLibrariesCannotLoad() async {
    let script = FetchScript([.failure(URLError(.timedOut)), .success([Self.library])])
    let enumerator = workingSet(
      session: seedSession(folderID: Self.libraryID),
      rootCache: rootCache { try script.next() })

    let failed = await enumerateSeed(enumerator)
    XCTAssertNotNil(failed.error, "the OS must retry, not receive top-level items")
    XCTAssertTrue(failed.batches.flatMap { $0 }.isEmpty)

    let retried = await enumerateSeed(enumerator)
    XCTAssertNil(retried.error)
    let items = retried.batches.flatMap { $0 }
    XCTAssertEqual(items.map(\.filename).sorted(), Self.filenames.sorted())
    XCTAssertEqual(Set(items.map(\.parentItemIdentifier)), [Self.sumacFolder])
  }

  func testSeedLeavesOutAnAssetWhoseLibraryIsNotListed() async {
    let enumerator = workingSet(
      session: seedSession(folderID: "aaaaaaaaaaaaaaaaaaaaaaaa"),
      rootCache: rootCache { [Self.library] })

    let observer = await enumerateSeed(enumerator)

    XCTAssertNil(observer.error)
    XCTAssertTrue(observer.batches.flatMap { $0 }.isEmpty)
  }

  func testChangesFailInsteadOfParentingAtTheTopLevelWhenLibrariesCannotLoad() async {
    let session = URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      let body = """
        {"changes": [{"cursor": 4, "asset_id": "000000000000000000000001",
          "folder_id": "\(Self.libraryID)", "relative_path": "2025/Sumac/0001/_84A9562.CR2",
          "kind": "create", "abs_path": null, "at": "2026-10-28T22:00:00Z"}], "next_cursor": 4}
        """
      return (Data(body.utf8), resp)
    }
    let enumerator = workingSet(session: session, rootCache: rootCache { throw URLError(.timedOut) })
    let observer = TestChangeObserver()

    enumerator.enumerateChanges(for: observer, from: WorkingSetEnumerator.anchor(0))
    let finished = await observer.waitUntilFinished(timeoutSeconds: 5)

    XCTAssertTrue(finished)
    XCTAssertNotNil(observer.error)
    XCTAssertTrue(observer.updates.isEmpty)
  }

  private final class AnchorObserver: NSObject, NSFileProviderChangeObserver, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [NSFileProviderItem] = []
    private var anchor: NSFileProviderSyncAnchor?
    private var failure: Error?
    private var finished = false
    var updates: [NSFileProviderItem] { lock.withLock { items } }
    var finalAnchor: NSFileProviderSyncAnchor? { lock.withLock { anchor } }
    var error: Error? { lock.withLock { failure } }
    func didUpdate(_ updatedItems: [NSFileProviderItemProtocol]) {
      lock.withLock { items += updatedItems as! [NSFileProviderItem] }
    }
    func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) {}
    func finishEnumeratingChanges(upTo newAnchor: NSFileProviderSyncAnchor, moreComing: Bool) {
      lock.withLock {
        anchor = newAnchor
        finished = true
      }
    }
    func finishEnumeratingWithError(_ error: Error) {
      lock.withLock {
        failure = error
        finished = true
      }
    }
    func waitUntilFinished() async -> Bool {
      for _ in 0..<100 {
        if lock.withLock({ finished }) { return true }
        try? await Task.sleep(for: .milliseconds(50))
      }
      return false
    }
  }

  func testAChangeInALibraryAddedSinceTheListWasCachedIsDelivered() async throws {
    let assetID = "000000000000000000000003"
    let session = URLSession.stubbedSequence { req in
      let ok = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      if req.url!.path.contains("/api/changes") {
        let body = """
          {"changes": [{"cursor": 8, "asset_id": "\(assetID)", "folder_id": "\(Self.libraryID)",
            "relative_path": "2025/Sumac/0001/_84A9568.CR2",
            "kind": "create", "abs_path": null, "at": "2026-10-28T22:00:00Z"}], "next_cursor": 8}
          """
        return (Data(body.utf8), ok)
      }
      let body = """
        {"assets": [{"id": "\(assetID)", "folder_id": "\(Self.libraryID)", "filename": "_84A9568.CR2",
          "abs_path": "/srv/photos/Maple/2025/Sumac/0001/_84A9568.CR2", "size": 1,
          "mtime": 1758412800000, "rating": 0}]}
        """
      return (Data(body.utf8), ok)
    }
    let script = FetchScript([.success([]), .success([Self.library])])
    let cache = rootCache { try script.next() }
    _ = try await cache.roots()
    let enumerator = workingSet(session: session, rootCache: cache)

    let observer = AnchorObserver()

    enumerator.enumerateChanges(for: observer, from: WorkingSetEnumerator.anchor(0))
    let finished = await observer.waitUntilFinished()

    XCTAssertTrue(finished)
    XCTAssertNil(observer.error)
    XCTAssertEqual(observer.updates.first?.parentItemIdentifier, Self.sumacFolder,
                   "the change must be delivered before the anchor moves past it")
    XCTAssertEqual(observer.finalAnchor.flatMap(WorkingSetEnumerator.parseAnchor), 8)
  }

  func testASeedEntryInALibraryAddedSinceTheListWasCachedIsListed() async throws {
    let script = FetchScript([.success([]), .success([Self.library])])
    let cache = rootCache { try script.next() }
    _ = try await cache.roots()
    let enumerator = workingSet(session: seedSession(folderID: Self.libraryID), rootCache: cache)

    let observer = await enumerateSeed(enumerator)

    XCTAssertEqual(Set(observer.batches.flatMap { $0 }.map(\.parentItemIdentifier)), [Self.sumacFolder])
  }

  func testABareCursorAnchorExpiresSoTheWorkingSetIsListedAgain() async {
    let session = URLSession.stubbedSequence { req in
      XCTFail("an expired anchor must not reach the server: \(req.url!)")
      return (Data(), HTTPURLResponse(url: req.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!)
    }
    let enumerator = workingSet(session: session, rootCache: rootCache { [Self.library] })
    let observer = TestChangeObserver()

    enumerator.enumerateChanges(for: observer, from: NSFileProviderSyncAnchor(Data("120".utf8)))
    let finished = await observer.waitUntilFinished(timeoutSeconds: 5)

    XCTAssertTrue(finished)
    XCTAssertEqual((observer.error as NSError?)?.code, NSFileProviderError.syncAnchorExpired.rawValue)
    XCTAssertEqual(WorkingSetEnumerator.parseAnchor(WorkingSetEnumerator.anchor(120)), 120)
  }

  func testAnInvalidationDuringAColdFetchDoesNotFailTheCaller() async throws {
    let script = FetchScript([.success([Self.library])])
    let (started, signalStarted) = AsyncStream<Void>.makeStream()
    let cache = rootCache {
      let served = try script.next()
      if script.callCount == 1 {
        signalStarted.yield()
        try await Task.sleep(for: .seconds(30))
      }
      return served
    }

    async let roots = cache.roots()
    for await _ in started { break }
    await cache.invalidate()

    let served = try await roots
    XCTAssertEqual(served, [Self.library])
    XCTAssertEqual(script.callCount, 2)
  }

  func testAssetParentNeverFallsBackToTheTopLevel() async throws {
    let meta = AssetMetadata(
      id: "000000000000000000000001", folderID: Self.libraryID, filename: "_84A9562.CR2",
      absPath: "/srv/photos/Maple/2025/Sumac/0001/_84A9562.CR2", size: 67_900_000,
      mtimeMS: 1_758_412_800_000, rating: 0)

    let parent = try await FileProviderExtensionCore.resolveAssetParent(
      meta: meta, rootCache: rootCache { [Self.library] })
    XCTAssertEqual(parent, Self.sumacFolder)

    do {
      _ = try await FileProviderExtensionCore.resolveAssetParent(
        meta: meta, rootCache: rootCache { throw URLError(.timedOut) })
      XCTFail("a failed library list must propagate")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .timedOut, "a load failure is retryable, not noSuchItem")
    }

    do {
      _ = try await FileProviderExtensionCore.resolveAssetParent(
        meta: meta, rootCache: rootCache { [] })
      XCTFail("an unlisted library must be noSuchItem")
    } catch {
      XCTAssertEqual((error as NSError).code, NSFileProviderError.noSuchItem.rawValue)
    }
  }

  func testAssetParentRefetchesALibraryListThatPredatesTheLibrary() async throws {
    let script = FetchScript([.success([]), .success([Self.library])])
    let cache = rootCache { try script.next() }
    _ = try await cache.roots()
    let meta = AssetMetadata(
      id: "000000000000000000000001", folderID: Self.libraryID, filename: "_84A9562.CR2",
      absPath: "/srv/photos/Maple/2025/Sumac/0001/_84A9562.CR2", size: 1,
      mtimeMS: 0, rating: 0)

    let parent = try await FileProviderExtensionCore.resolveAssetParent(meta: meta, rootCache: cache)

    XCTAssertEqual(parent, Self.sumacFolder)
  }

  func testRevalidatingKeepsServingTheListThroughAnUploadBurst() async throws {
    let script = FetchScript([.success([Self.library]), .failure(URLError(.cancelled))])
    let cache = rootCache { try script.next() }
    _ = try await cache.roots()

    for _ in 0..<20 { await cache.revalidate() }
    let served = try await cache.roots()

    XCTAssertEqual(served, [Self.library])
  }

  func testAPathlessChangeWhoseMetadataFailsIsSkippedNotPlacedAtTheTopLevel() async {
    let session = URLSession.stubbedSequence { req in
      let path = req.url!.path
      if path.contains("/api/changes") {
        let ok = HTTPURLResponse(
          url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "application/json"])!
        let body = """
          {"changes": [{"cursor": 6, "asset_id": "000000000000000000000002", "folder_id": null,
            "kind": "update", "abs_path": null, "at": "2026-10-28T22:00:00Z"}], "next_cursor": 6}
          """
        return (Data(body.utf8), ok)
      }
      let status = path.hasSuffix("/batch-meta") ? 404 : 500
      return (Data(), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
    let enumerator = workingSet(session: session, rootCache: rootCache { [Self.library] })
    let observer = TestChangeObserver()

    enumerator.enumerateChanges(for: observer, from: WorkingSetEnumerator.anchor(0))
    let finished = await observer.waitUntilFinished(timeoutSeconds: 5)

    XCTAssertTrue(finished)
    XCTAssertNil(observer.error)
    XCTAssertTrue(observer.updates.isEmpty)
  }

  func testThumbnailsServeTheServerThumbForAPhotoThatIsNotDownloaded() async {
    let thumbBytes = Data("avif-bytes".utf8)
    let catalog = FPCoreTestSupport.makeCatalog { req in
      req.url!.path.hasSuffix("/thumb") ? (200, thumbBytes, [:]) : (404, Data(), [:])
    }
    let core = FPCoreTestSupport.makeCore(catalog: catalog, roots: [Self.library], test: self)
    let photo = NSFileProviderItemIdentifier(FileProviderIdentifier.asset("000000000000000000000001").rawValue)
    let video = NSFileProviderItemIdentifier(
      FileProviderIdentifier.file(folderID: Self.libraryID, relativePath: "2025/clip.mov").rawValue)
    let delivered = Delivered()

    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      _ = core.fetchThumbnails(
        for: [photo, video], requestedSize: CGSize(width: 256, height: 256),
        perThumbnailCompletionHandler: { identifier, data, _ in delivered.record(identifier, data) },
        completionHandler: { _ in done.resume() })
    }

    let data = delivered.data
    XCTAssertEqual(data[photo] ?? nil, thumbBytes)
    XCTAssertEqual(data.keys.contains(video), true, "every requested item gets an answer")
    XCTAssertNil(data[video] ?? nil, "a non-indexed file keeps the system icon")
  }

  private final class Delivered: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [NSFileProviderItemIdentifier: Data?] = [:]
    func record(_ identifier: NSFileProviderItemIdentifier, _ data: Data?) {
      lock.withLock { values[identifier] = data }
    }
    var data: [NSFileProviderItemIdentifier: Data?] { lock.withLock { values } }
  }
}
