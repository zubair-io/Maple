// CloudThumbnailTokenTests.swift — #6175: a cached cloud thumbnail follows the
// server's thumbnail token, and the thumbnail fetch leaves no second HTTP copy.

import XCTest

@testable import MapleCore

final class CloudThumbnailTokenTests: XCTestCase {

  private var keys: [String] = []

  override func tearDown() async throws {
    for key in keys {
      removeSourcelessThumbCacheFile(forKey: key)
      try? FileManager.default.removeItem(
        at: sourcelessThumbCacheFileURL(forKey: key).appendingPathExtension("source"))
    }
    keys = []
  }

  private func uniqueKey() -> String {
    let key = "fs:/srv/photos/\(UUID().uuidString).dng"
    keys.append(key)
    return key
  }

  func testBytesFetchedForAnotherTokenAreAMiss() async {
    let key = uniqueKey()
    let cache = ThumbnailDiskCache()
    await cache.storeThumbnailData(Data("old".utf8), forKey: key, token: "t1")

    let sameToken = await cache.thumbnailData(forKey: key, currentToken: "t1")
    let newToken = await cache.thumbnailData(forKey: key, currentToken: "t2")
    let noToken = await cache.thumbnailData(forKey: key)

    XCTAssertEqual(sameToken, Data("old".utf8))
    XCTAssertNil(newToken)
    XCTAssertEqual(noToken, Data("old".utf8), "a listing with no token keeps today's behaviour")
  }

  func testTokenSurvivesANewCacheInstance() async {
    let key = uniqueKey()
    await ThumbnailDiskCache().storeThumbnailData(Data("old".utf8), forKey: key, token: "t1")

    let relaunched = ThumbnailDiskCache()
    let sameToken = await relaunched.thumbnailData(forKey: key, currentToken: "t1")
    let newToken = await ThumbnailDiskCache().thumbnailData(forKey: key, currentToken: "t2")

    XCTAssertEqual(sameToken, Data("old".utf8))
    XCTAssertNil(newToken)
  }

  func testEntryWithoutARecordedTokenIsRefetchedOnce() async {
    let key = uniqueKey()
    await ThumbnailDiskCache().storeThumbnailData(Data("old".utf8), forKey: key)

    let cache = ThumbnailDiskCache()
    let beforeRefetch = await cache.thumbnailData(forKey: key, currentToken: "t1")
    await cache.storeThumbnailData(Data("new".utf8), forKey: key, token: "t1")
    let afterRefetch = await cache.thumbnailData(forKey: key, currentToken: "t1")

    XCTAssertNil(beforeRefetch)
    XCTAssertEqual(afterRefetch, Data("new".utf8))
  }

  func testStoringWithoutATokenClearsTheEarlierOne() async {
    let key = uniqueKey()
    let cache = ThumbnailDiskCache()
    await cache.storeThumbnailData(Data("old".utf8), forKey: key, token: "t1")
    await cache.storeThumbnailData(Data("newer".utf8), forKey: key)

    let hit = await ThumbnailDiskCache().thumbnailData(forKey: key, currentToken: "t1")
    XCTAssertNil(hit)
  }

  func testTokenMapDropsOnlyTheOldestEntriesPastItsCap() async {
    let cache = ThumbnailDiskCache(fetchedTokenCapacity: 3)
    let all = (0..<5).map { _ in uniqueKey() }
    for key in all { await cache.storeThumbnailData(Data("b".utf8), forKey: key, token: "t") }

    let remembered = await cache.rememberedTokenKeysOldestFirst
    XCTAssertEqual(remembered, all.suffix(3).map { MapleThumbCacheKey.sha256Prefix16($0) })
    let evicted = await cache.thumbnailData(forKey: all[0], currentToken: "t")
    XCTAssertEqual(evicted, Data("b".utf8), "an evicted token is re-read from its stamp")
  }

  private actor TokenSource: ImageSource {
    private(set) var thumbCalls = 0
    var bytes = Data("v1".utf8)
    var failing = false
    var answersNothing = false
    var plainFailure = false
    private let token = OSAllocatedUnfairLockBox()

    func setToken(_ value: String?) { token.value = value }
    func setBytes(_ value: Data) { bytes = value }
    func setFailing(_ value: Bool) { failing = value }
    func setAnswersNothing(_ value: Bool) { answersNothing = value }
    func setPlainFailure(_ value: Bool) { plainFailure = value }

    nonisolated func thumbToken(for ref: ImageRef) -> String? { token.value }
    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? {
      thumbCalls += 1
      if failing { throw URLError(.notConnectedToInternet) }
      if plainFailure { throw NSError(domain: "CloudSource", code: 503) }
      if answersNothing { return nil }
      return bytes
    }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data { Data() }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }

  private final class OSAllocatedUnfairLockBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: String?
    var value: String? {
      get { lock.withLock { stored } }
      set { lock.withLock { stored = newValue } }
    }
  }

  private func asset(key: String) -> AssetRef {
    AssetRef(
      displayName: "x.dng", hintExtension: "dng", stableID: key, bytesProvider: { Data() })
  }

  func testLoaderRefetchesOnlyWhenTheListingTokenChanges() async {
    let key = uniqueKey()
    let source = TokenSource()
    await source.setToken("t1")
    let loader = ThumbnailLoader()
    let asset = asset(key: key)

    let first = await loader.load(for: asset, from: source)
    let second = await loader.load(for: asset, from: source)
    let callsWhileUnchanged = await source.thumbCalls
    await source.setToken("t2")
    await source.setBytes(Data("v2".utf8))
    let third = await loader.load(for: asset, from: source)
    let fourth = await loader.load(for: asset, from: source)
    let callsAfterChange = await source.thumbCalls

    XCTAssertEqual(first, Data("v1".utf8))
    XCTAssertEqual(second, Data("v1".utf8))
    XCTAssertEqual(callsWhileUnchanged, 1)
    XCTAssertEqual(third, Data("v2".utf8))
    XCTAssertEqual(fourth, Data("v2".utf8))
    XCTAssertEqual(callsAfterChange, 2)
  }

  func testListingWithoutATokenKeepsServingTheCache() async {
    let key = uniqueKey()
    let source = TokenSource()
    let loader = ThumbnailLoader()
    let asset = asset(key: key)

    _ = await loader.load(for: asset, from: source)
    await source.setBytes(Data("v2".utf8))
    let again = await loader.load(for: asset, from: source)

    XCTAssertEqual(again, Data("v1".utf8))
    let calls = await source.thumbCalls
    XCTAssertEqual(calls, 1)
  }

  func testChangedTokenWhileOfflineStillShowsTheOldThumbnail() async {
    let key = uniqueKey()
    let source = TokenSource()
    await source.setToken("t1")
    let loader = ThumbnailLoader()
    let asset = asset(key: key)
    _ = await loader.load(for: asset, from: source)

    await source.setToken("t2")
    await source.setFailing(true)
    let offline = await loader.load(for: asset, from: source)

    XCTAssertEqual(offline, Data("v1".utf8))
  }

  func testChangedTokenWhenTheServerAnswersNothingOrFailsServesTheOldThumbnailAndRetries() async {
    for (label, arrange) in [
      ("404 or 202", { (source: TokenSource) in await source.setAnswersNothing(true) }),
      ("5xx", { (source: TokenSource) in await source.setPlainFailure(true) }),
    ] {
      let key = uniqueKey()
      let source = TokenSource()
      await source.setToken("t1")
      let loader = ThumbnailLoader()
      let asset = asset(key: key)
      _ = await loader.load(for: asset, from: source)

      await source.setToken("t2")
      await arrange(source)
      let stale = await loader.load(for: asset, from: source)
      XCTAssertEqual(stale, Data("v1".utf8), label)

      await source.setAnswersNothing(false)
      await source.setPlainFailure(false)
      await source.setBytes(Data("v2".utf8))
      let recovered = await loader.load(for: asset, from: source)
      XCTAssertEqual(recovered, Data("v2".utf8), "\(label): the new token was not recorded")
    }
  }

  func testCloudSourceReportsTheListedTokenAndSendsItAsV() async throws {
    let libPath = "/srv/photos/Library"
    let server = URL(string: "https://x")!
    let session = URLSession.stubbedSequence { req in
      let body: String
      switch req.url?.path {
      case "/api/folders":
        body = """
          [{"id":"f1","slug":"library","path":"\(libPath)","label":"Library",
            "last_scan":null,"file_count":1,"created_at":"2026-01-01T00:00:00Z"}]
          """
      default:
        body = """
          {"path":"\(libPath)","parentPath":null,"folders":[],"images":[\
          {"name":"a.dng","path":"\(libPath)/a.dng","mtime":"2026-01-01T00:00:00Z",\
          "size":1024,"ext":"dng","exif":null,"thumbVersion":"m1k-2s"}]}
          """
      }
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(body.utf8), resp)
    }
    let cloud = CloudSource(
      server: server, folderID: "f1", libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let ref = ImageRef(id: "fs:\(libPath)/a.dng", displayName: "a.dng")

    XCTAssertNil(cloud.thumbToken(for: ref))
    _ = try await cloud.images()
    XCTAssertEqual(cloud.thumbToken(for: ref), "m1k-2s")
  }

  private final class CacheableProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Cache-Control": "max-age=3600", "Content-Type": "image/avif"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .allowed)
      client?.urlProtocol(self, didLoad: Data("AVIF".utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
  }

  func testThumbnailFetchLeavesNoCopyInTheSessionURLCache() async throws {
    let cache = URLCache(memoryCapacity: 1_000_000, diskCapacity: 0)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CacheableProtocol.self]
    configuration.urlCache = cache
    let server = URL(string: "https://x")!
    let client = AuthenticatedHTTPClient.unauthenticated(
      server: server, urlSession: URLSession(configuration: configuration))
    let ordinary = URLRequest(url: URL(string: "https://x/api/other")!)
    let thumbnail = URLRequest(url: URL(string: "https://x/api/thumb/library/a.dng")!)

    _ = try await client.data(for: ordinary)
    _ = try await client.dataWithoutResponseCache(for: thumbnail)

    XCTAssertNotNil(cache.cachedResponse(for: ordinary), "unrelated requests keep their cache")
    XCTAssertNil(cache.cachedResponse(for: thumbnail))
  }
}
