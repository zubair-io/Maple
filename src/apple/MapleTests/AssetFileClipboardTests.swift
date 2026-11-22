#if os(macOS)
  import MapleCore
  import XCTest
  @testable import Maple

  final class AssetFileClipboardTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
      root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    @MainActor
    func testLocalOriginalIsCopiedByItsOwnURLWithoutStaging() async throws {
      let original = root.appendingPathComponent("photo.dng")
      try Data([1, 2, 3]).write(to: original)
      let staging = root.appendingPathComponent("staging")

      let urls = try await AssetFileClipboard.stage([AssetRef(url: original)], in: staging)

      XCTAssertEqual(urls, [original])
      XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
    }

    @MainActor
    func testRemoteOriginalsAreFetchedAndSameNamesStayDistinct() async throws {
      let staging = root.appendingPathComponent("staging")
      let first = remoteAsset(name: "IMG_1.dng", bytes: Data([1]))
      let second = remoteAsset(name: "IMG_1.dng", bytes: Data([2]))

      let urls = try await AssetFileClipboard.stage([first, second], in: staging)

      XCTAssertEqual(urls.map(\.lastPathComponent), ["IMG_1.dng", "IMG_1.dng"])
      XCTAssertEqual(Set(urls).count, 2)
      XCTAssertEqual(try urls.map { try Data(contentsOf: $0) }, [Data([1]), Data([2])])
    }

    @MainActor
    func testEarlierCopyStaysUntilItsReplacementIsPublished() async throws {
      let earlierBatch = root.appendingPathComponent("earlier")
      let laterBatch = root.appendingPathComponent("later")
      let earlier = try await AssetFileClipboard.stage(
        [remoteAsset(name: "IMG.jpg", bytes: Data([1]))], in: earlierBatch)
      let later = try await AssetFileClipboard.stage(
        [remoteAsset(name: "IMG.jpg", bytes: Data([2]))], in: laterBatch)

      XCTAssertEqual(try Data(contentsOf: earlier[0]), Data([1]))
      AssetFileClipboard.removeStagedCopies(in: root, except: laterBatch)

      XCTAssertFalse(FileManager.default.fileExists(atPath: earlier[0].path))
      XCTAssertEqual(try Data(contentsOf: later[0]), Data([2]))
    }

    @MainActor
    func testFailedFetchFailsTheCopy() async {
      let offline = AssetRef(
        displayName: "offline.dng", hintExtension: "dng",
        originalFileWriter: { _ in throw ImageSourceError.notFound("offline") },
        bytesProvider: { Data() })
      do {
        _ = try await AssetFileClipboard.stage([offline], in: root.appendingPathComponent("s"))
        XCTFail("A failed fetch must not reach the pasteboard")
      } catch {}
    }

    @MainActor
    func testTimelineTileResolvesItsLocalFile() {
      let url = root.appendingPathComponent("local.heic")
      let actions = TimelineFileActions(
        cloudAsset: { _, _ in XCTFail("local tile must not resolve a server"); return AssetRef(url: url) },
        localAsset: { AssetRef(fileBacked: $0) })
      let cell = MergedTimelineCell.localOnly(ImageRef(id: "local", displayName: "local.heic", url: url))

      let assets = actions.resolve(cell, absPathMap: [:], server: { _ in nil })

      XCTAssertEqual(assets.map(\.primaryURL), [url])
    }

    @MainActor
    func testCloudTileWithoutItsAssetResolvesNothing() {
      let actions = TimelineFileActions(
        cloudAsset: { _, _ in XCTFail("unresolved tile must not build a ref"); return AssetRef(url: URL(fileURLWithPath: "/")) },
        localAsset: { _ in nil })
      let cell = MergedTimelineCell.cloudOnly(ImageRef(id: "fs:/a.dng", displayName: "a.dng", url: nil))

      XCTAssertTrue(actions.resolve(cell, absPathMap: [:], server: { _ in nil }).isEmpty)
    }

    func testTileDragIdentityIsStablePerTile() {
      XCTAssertEqual(TimelineFileActions.tileID("fs:/a.dng"), TimelineFileActions.tileID("fs:/a.dng"))
      XCTAssertNotEqual(
        TimelineFileActions.tileID("fs:/a.dng"), TimelineFileActions.tileID("fs:/b.dng"))
    }

    private func remoteAsset(name: String, bytes: Data) -> AssetRef {
      AssetRef(
        displayName: name, hintExtension: (name as NSString).pathExtension,
        originalFileWriter: { try bytes.write(to: $0) },
        bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })
    }
  }
#endif
