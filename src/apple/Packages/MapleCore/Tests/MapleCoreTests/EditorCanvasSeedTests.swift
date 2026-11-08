// EditorCanvasSeedTests — #5731. A Maple Cloud folder-browse asset must seed
// the editor canvas from the thumbnail its grid already cached, without ever
// downloading the original.

import MapleCloudKit
import XCTest

@testable import MapleCore

final class EditorCanvasSeedTests: XCTestCase {
  private actor StubSource: ImageSource {
    private(set) var thumbIDs: [String] = []
    let thumbBytes: Data?

    init(thumbBytes: Data?) { self.thumbBytes = thumbBytes }

    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? {
      thumbIDs.append(ref.id)
      return thumbBytes
    }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data {
      XCTFail("the seed must never download the original")
      return Data()
    }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }

  private var cloudThumbsDir: URL!
  private var stableID: String!
  private let server = URL(string: "https://maple.example.test")!

  override func setUp() {
    super.setUp()
    cloudThumbsDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("editor-canvas-seed-\(UUID().uuidString)", isDirectory: true)
    stableID = "fs:/library/2026/IMG_\(UUID().uuidString).dng"
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: cloudThumbsDir)
    removeSourcelessThumbCacheFile(forKey: stableID)
    super.tearDown()
  }

  private var absPath: String { String(stableID.dropFirst(3)) }

  /// Shaped like `BrowseViewModel.loadCloudDir`'s refs.
  private func folderBrowseAsset() -> (AssetRef, CatalogRef) {
    let catalog = CatalogRef(
      serverID: server, folderID: "lib", absPath: absPath, address: nil)
    let asset = AssetRef(
      displayName: "IMG.dng", hintExtension: "dng", stableID: stableID,
      catalog: catalog,
      bytesProvider: {
        XCTFail("the seed must never download the original")
        return Data()
      })
    return (asset, catalog)
  }

  func testFolderBrowseAssetSeedsFromTheFilmstripsSourcelessThumbnail() async {
    let (asset, catalog) = folderBrowseAsset()
    let gridThumb = Data([0x01, 0x02, 0x03])
    await ThumbnailDiskCache.shared.storeThumbnailData(gridThumb, forKey: stableID)
    let cloudThumbs = CloudThumbCache(baseDir: cloudThumbsDir)
    let source = StubSource(thumbBytes: Data([0xFF]))

    let bytes = await EditorCanvasSeed.cloudThumbnailBytes(
      asset: asset, catalog: catalog, server: source, cloudThumbs: cloudThumbs)

    let cloudCached = await cloudThumbs.get(host: server.cacheHostKey, absPath: absPath)
    XCTAssertNil(cloudCached, "folder browse never writes the Cloud thumbnail cache")
    XCTAssertEqual(bytes, gridThumb)
    let fetched = await source.thumbIDs
    XCTAssertEqual(fetched, [], "a cached thumbnail needs no server fetch")
  }

  func testTimelineCachedThumbnailWins() async {
    let (asset, catalog) = folderBrowseAsset()
    let cloudThumbs = CloudThumbCache(baseDir: cloudThumbsDir)
    let timelineThumb = Data([0x0A, 0x0B])
    await cloudThumbs.put(host: server.cacheHostKey, absPath: absPath, timelineThumb)
    await ThumbnailDiskCache.shared.storeThumbnailData(Data([0x01]), forKey: stableID)

    let bytes = await EditorCanvasSeed.cloudThumbnailBytes(
      asset: asset, catalog: catalog, server: nil, cloudThumbs: cloudThumbs)

    XCTAssertEqual(bytes, timelineThumb)
  }

  func testUncachedThumbnailIsFetchedFromTheServerAndKeptForTheGrid() async {
    let (asset, catalog) = folderBrowseAsset()
    let serverThumb = Data([0x0C, 0x0D, 0x0E])
    let source = StubSource(thumbBytes: serverThumb)

    let bytes = await EditorCanvasSeed.cloudThumbnailBytes(
      asset: asset, catalog: catalog, server: source,
      cloudThumbs: CloudThumbCache(baseDir: cloudThumbsDir))

    XCTAssertEqual(bytes, serverThumb)
    let fetched = await source.thumbIDs
    XCTAssertEqual(fetched, ["fs:\(absPath)"])
    let stored = await ThumbnailDiskCache.shared.thumbnailData(forKey: stableID)
    XCTAssertEqual(stored, serverThumb)
  }

  func testNoThumbnailAnywhereLeavesTheSeedEmptyWithoutDownloadingTheOriginal() async {
    let (asset, catalog) = folderBrowseAsset()
    let source = StubSource(thumbBytes: nil)

    let bytes = await EditorCanvasSeed.cloudThumbnailBytes(
      asset: asset, catalog: catalog, server: source,
      cloudThumbs: CloudThumbCache(baseDir: cloudThumbsDir))

    XCTAssertNil(bytes)
    let fetched = await source.thumbIDs
    XCTAssertEqual(fetched, ["fs:\(absPath)"])
  }

  func testOnlyASourceForTheAssetsOwnServerIsAskedForItsThumbnail() {
    let (_, catalog) = folderBrowseAsset()
    let own = cloudSource(identity: server)
    let other = cloudSource(identity: URL(string: "https://other.example.test")!)

    XCTAssertTrue(EditorCanvasSeed.server(own, serving: catalog) === own)
    XCTAssertNil(EditorCanvasSeed.server(other, serving: catalog))
    XCTAssertNil(EditorCanvasSeed.server(StubSource(thumbBytes: nil), serving: catalog))
    XCTAssertNil(EditorCanvasSeed.server(nil, serving: catalog))
  }

  /// The LAN-resolved request URL may differ; identity is what must match.
  private func cloudSource(identity: URL) -> CloudSource {
    let lan = URL(string: "http://192.168.1.20:3000")!
    return CloudSource(
      server: lan, identity: identity, folderID: "lib", libraryPath: "/library",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: lan, urlSession: .shared))
  }

  func testSeedStaysUpUntilRealPixelsAreOnScreen() {
    XCTAssertTrue(EditorCanvasSeed.isVisible(showingOriginal: false, hasOnscreenFrame: false))
    XCTAssertFalse(EditorCanvasSeed.isVisible(showingOriginal: false, hasOnscreenFrame: true))
    XCTAssertFalse(EditorCanvasSeed.isVisible(showingOriginal: true, hasOnscreenFrame: false))
  }
}
