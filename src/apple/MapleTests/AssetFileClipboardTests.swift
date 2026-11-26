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
      let published = Published()
      let clipboard = AssetFileClipboard(
        stagingRoot: root,
        publish: { urls, _ in published.record(urls) },
        report: { XCTFail("unexpected error: \($0)") })

      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([1]))])
      await clipboard.copyTask?.value
      let earlier = try XCTUnwrap(published.latest.first)

      published.beforeRecording = {
        XCTAssertEqual(try? Data(contentsOf: earlier), Data([1]), "still pasteable mid-copy")
      }
      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([2]))])
      await clipboard.copyTask?.value

      let later = try XCTUnwrap(published.latest.first)
      XCTAssertFalse(FileManager.default.fileExists(atPath: earlier.path))
      XCTAssertEqual(try Data(contentsOf: later), Data([2]))
      XCTAssertEqual(try stagedBatches().count, 1)
    }

    @MainActor
    func testFailedFetchLeavesTheClipboardAndItsFilesAlone() async throws {
      let published = Published()
      var reported: [Error] = []
      let clipboard = AssetFileClipboard(
        stagingRoot: root,
        publish: { urls, _ in published.record(urls) },
        report: { reported.append($0) })
      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([1]))])
      await clipboard.copyTask?.value
      let earlier = try XCTUnwrap(published.latest.first)

      let offline = AssetRef(
        displayName: "offline.dng", hintExtension: "dng",
        originalFileWriter: { _ in throw ImageSourceError.notFound("offline") },
        bytesProvider: { Data() })
      clipboard.copy([offline])
      await clipboard.copyTask?.value

      XCTAssertEqual(published.count, 1, "a failed fetch must not reach the pasteboard")
      XCTAssertEqual(reported.count, 1)
      XCTAssertEqual(try Data(contentsOf: earlier), Data([1]))
      XCTAssertEqual(try stagedBatches().count, 1, "the failed copy removes only its own folder")
    }

    @MainActor
    func testRefusedPasteboardWriteKeepsTheEarlierFilesAndReports() async throws {
      let published = Published()
      var reported: [Error] = []
      let clipboard = AssetFileClipboard(
        stagingRoot: root,
        publish: { urls, _ in published.record(urls) },
        report: { reported.append($0) })
      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([1]))])
      await clipboard.copyTask?.value
      let earlier = try XCTUnwrap(published.latest.first)

      published.accepts = false
      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([2]))])
      await clipboard.copyTask?.value

      XCTAssertEqual(reported.count, 1)
      XCTAssertEqual(try Data(contentsOf: earlier), Data([1]))
      XCTAssertEqual(try stagedBatches().count, 1)
    }

    @MainActor
    func testNewCopyCancelsTheOneStillRunning() async throws {
      let published = Published()
      let clipboard = AssetFileClipboard(
        stagingRoot: root,
        publish: { urls, _ in published.record(urls) },
        report: { XCTFail("unexpected error: \($0)") })

      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([1]))])
      let superseded = clipboard.copyTask
      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([2]))])
      await superseded?.value
      await clipboard.copyTask?.value

      XCTAssertEqual(published.count, 1, "only the newest Copy reaches the pasteboard")
      XCTAssertEqual(try Data(contentsOf: try XCTUnwrap(published.latest.first)), Data([2]))
      XCTAssertEqual(try stagedBatches().count, 1)
    }

    @MainActor
    func testOnlyACopysOwnFolderIsEverRemoved() async throws {
      let bystander = root.appendingPathComponent("not-a-copy.dng")
      try Data([9]).write(to: bystander)
      let published = Published()
      let clipboard = AssetFileClipboard(
        stagingRoot: root,
        publish: { urls, _ in published.record(urls) },
        report: { XCTFail("unexpected error: \($0)") })

      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([1]))])
      await clipboard.copyTask?.value
      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([2]))])
      await clipboard.copyTask?.value

      XCTAssertEqual(try Data(contentsOf: bystander), Data([9]))
      XCTAssertEqual(try stagedBatches().count, 2, "the bystander and the newest copy")
    }

    @MainActor
    func testCopyOfNothingLeavesARunningCopyAlone() async throws {
      let published = Published()
      let clipboard = AssetFileClipboard(
        stagingRoot: root,
        publish: { urls, _ in published.record(urls) },
        report: { XCTFail("unexpected error: \($0)") })

      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([1]))])
      clipboard.copy([])
      await clipboard.copyTask?.value

      XCTAssertEqual(published.count, 1)
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

    private func stagedBatches() throws -> [URL] {
      try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    }

    @MainActor
    private final class Published {
      private(set) var latest: [URL] = []
      private(set) var count = 0
      var accepts = true
      var beforeRecording: () -> Void = {}

      func record(_ urls: [URL]) -> Bool {
        beforeRecording()
        guard accepts else { return false }
        latest = urls
        count += 1
        return true
      }
    }

    private func remoteAsset(name: String, bytes: Data) -> AssetRef {
      AssetRef(
        displayName: name, hintExtension: (name as NSString).pathExtension,
        originalFileWriter: { try bytes.write(to: $0) },
        bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })
    }
  }
#endif
