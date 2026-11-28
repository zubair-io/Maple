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

    /// With an original's own path on the clipboard, Finder's "Move Item Here"
    /// would move the photo out of its library (decision 33).
    @MainActor
    func testLocalOriginalIsOfferedAsAStagedCopyNeverItsOwnPath() async throws {
      let original = root.appendingPathComponent("photo.dng")
      try Data([1, 2, 3]).write(to: original)
      let staging = root.appendingPathComponent("staging")

      let urls = try await AssetFileClipboard.stage([AssetRef(url: original)], in: staging)

      let staged = try XCTUnwrap(urls.first)
      XCTAssertEqual(urls.count, 1)
      XCTAssertNotEqual(staged.standardizedFileURL, original.standardizedFileURL)
      XCTAssertTrue(staged.standardizedFileURL.path.hasPrefix(staging.standardizedFileURL.path))
      XCTAssertEqual(staged.lastPathComponent, "photo.dng")
      XCTAssertEqual(try Data(contentsOf: staged), Data([1, 2, 3]))
      XCTAssertEqual(try Data(contentsOf: original), Data([1, 2, 3]))
    }

    @MainActor
    func testCopyNeverPublishesALocalOriginalsOwnPath() async throws {
      let original = root.appendingPathComponent("photo.dng")
      try Data([1, 2, 3]).write(to: original)
      let published = Published()
      let clipboard = AssetFileClipboard(
        stagingRoot: root.appendingPathComponent("clipboard"),
        publish: { published.record($0) },
        report: { XCTFail("unexpected error: \($0)") })

      clipboard.copy([AssetRef(url: original), remoteAsset(name: "IMG.jpg", bytes: Data([4]))])
      await clipboard.copyTask?.value

      let paths = published.latest.map(\.standardizedFileURL)
      XCTAssertEqual(paths.count, 2)
      XCTAssertFalse(paths.contains(original.standardizedFileURL))
      XCTAssertEqual(try paths.map { try Data(contentsOf: $0) }, [Data([1, 2, 3]), Data([4])])
    }

    @MainActor
    func testReplacingACopyRemovesOnlyTheStagedCopyNotTheOriginal() async throws {
      let original = root.appendingPathComponent("photo.dng")
      try Data([1, 2, 3]).write(to: original)
      let published = Published()
      let clipboard = AssetFileClipboard(
        stagingRoot: root.appendingPathComponent("clipboard"),
        publish: { published.record($0) },
        report: { XCTFail("unexpected error: \($0)") })

      clipboard.copy([AssetRef(url: original)])
      await clipboard.copyTask?.value
      let earlier = try XCTUnwrap(published.latest.first)
      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([4]))])
      await clipboard.copyTask?.value

      XCTAssertFalse(FileManager.default.fileExists(atPath: earlier.path))
      XCTAssertEqual(try Data(contentsOf: original), Data([1, 2, 3]))
    }

    @MainActor
    func testSymlinkedOriginalIsStagedAsARealFile() async throws {
      let original = root.appendingPathComponent("photo.dng")
      try Data([1, 2, 3]).write(to: original)
      let link = root.appendingPathComponent("link.dng")
      try FileManager.default.createSymbolicLink(at: link, withDestinationURL: original)

      let urls = try await AssetFileClipboard.stage(
        [AssetRef(url: link)], in: root.appendingPathComponent("staging"))

      let staged = try XCTUnwrap(urls.first)
      let attributes = try FileManager.default.attributesOfItem(atPath: staged.path)
      XCTAssertEqual(attributes[.type] as? FileAttributeType, .typeRegular)
      XCTAssertEqual(try Data(contentsOf: staged), Data([1, 2, 3]))
    }

    /// Finder is not sandboxed, so a link Maple can't follow would still lead it to the original.
    @MainActor
    func testLinkToAnUnreadableFileIsRefusedAndNothingIsPublished() async throws {
      let original = root.appendingPathComponent("photo.dng")
      try Data([1, 2, 3]).write(to: original)
      try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: original.path)
      defer {
        try? FileManager.default.setAttributes(
          [.posixPermissions: 0o644], ofItemAtPath: original.path)
      }
      let link = root.appendingPathComponent("link.dng")
      try FileManager.default.createSymbolicLink(at: link, withDestinationURL: original)
      let published = Published()
      var reported: [Error] = []
      let clipboard = AssetFileClipboard(
        stagingRoot: root.appendingPathComponent("clipboard"),
        publish: { published.record($0) },
        report: { reported.append($0) })

      clipboard.copy([AssetRef(url: link)])
      await clipboard.copyTask?.value

      XCTAssertEqual(published.count, 0)
      XCTAssertEqual(reported.count, 1)
      XCTAssertTrue(reported.first?.localizedDescription.contains("couldn't be copied") == true)
    }

    @MainActor
    func testDanglingLinkIsRefused() async throws {
      let link = root.appendingPathComponent("link.dng")
      try FileManager.default.createSymbolicLink(
        at: link, withDestinationURL: root.appendingPathComponent("gone.dng"))

      do {
        _ = try await AssetFileClipboard.stage(
          [AssetRef(url: link)], in: root.appendingPathComponent("staging"))
        XCTFail("a dangling link must not be staged")
      } catch {
        XCTAssertEqual(error as? FileOperationError, .sourceMissing("link.dng"))
      }
    }

    @MainActor
    func testLocalOriginalsThatShareANameStayDistinct() async throws {
      let first = root.appendingPathComponent("a/IMG_1.dng")
      let second = root.appendingPathComponent("b/IMG_1.dng")
      for (url, byte) in [(first, UInt8(1)), (second, UInt8(2))] {
        try FileManager.default.createDirectory(
          at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([byte]).write(to: url)
      }

      let staging = root.appendingPathComponent("staging")
      let urls = try await AssetFileClipboard.stage(
        [AssetRef(url: first), AssetRef(url: second)], in: staging)

      XCTAssertTrue(
        urls.allSatisfy {
          $0.standardizedFileURL.path.hasPrefix(staging.standardizedFileURL.path)
        })
      XCTAssertEqual(Set(urls).count, 2)
      XCTAssertEqual(urls.map(\.lastPathComponent), ["IMG_1.dng", "IMG_1.dng"])
      XCTAssertEqual(try urls.map { try Data(contentsOf: $0) }, [Data([1]), Data([2])])
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
        publish: { published.record($0) },
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
        publish: { published.record($0) },
        report: { reported.append($0) })
      clipboard.copy([remoteAsset(name: "IMG.jpg", bytes: Data([1]))])
      await clipboard.copyTask?.value
      let earlier = try XCTUnwrap(published.latest.first)

      let offline = AssetRef(
        displayName: "offline.dng", hintExtension: "dng",
        originalFileWriter: { _, _ in throw ImageSourceError.notFound("offline") },
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
        publish: { published.record($0) },
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
        publish: { published.record($0) },
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
        publish: { published.record($0) },
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
        publish: { published.record($0) },
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
        cloudAsset: { _, _ in
          XCTFail("local tile must not resolve a server")
          return AssetRef(url: url)
        },
        localAsset: { AssetRef(fileBacked: $0) })
      let cell = MergedTimelineCell.localOnly(
        ImageRef(id: "local", displayName: "local.heic", url: url))

      let assets = actions.resolve(cell, absPathMap: [:], server: { _ in nil })

      XCTAssertEqual(assets.map(\.primaryURL), [url])
    }

    @MainActor
    func testCloudTileWithoutItsAssetResolvesNothing() {
      let actions = TimelineFileActions(
        cloudAsset: { _, _ in
          XCTFail("unresolved tile must not build a ref")
          return AssetRef(url: URL(fileURLWithPath: "/"))
        },
        localAsset: { _ in nil })
      let cell = MergedTimelineCell.cloudOnly(
        ImageRef(id: "fs:/a.dng", displayName: "a.dng", url: nil))

      XCTAssertTrue(actions.resolve(cell, absPathMap: [:], server: { _ in nil }).isEmpty)
    }

    func testTileDragIdentityIsStablePerTile() {
      XCTAssertEqual(
        TimelineFileActions.tileID("fs:/a.dng"), TimelineFileActions.tileID("fs:/a.dng"))
      XCTAssertNotEqual(
        TimelineFileActions.tileID("fs:/a.dng"), TimelineFileActions.tileID("fs:/b.dng"))
    }

    private func stagedBatches(in directory: URL? = nil) throws -> [URL] {
      try FileManager.default.contentsOfDirectory(
        at: directory ?? root, includingPropertiesForKeys: nil)
    }

    @MainActor
    func testPublishedCopiesAreRemovedAfterTheirLifetime() async throws {
      let original = root.appendingPathComponent("photo.dng")
      try Data([1, 2, 3]).write(to: original)
      let published = Published()
      let clipboard = AssetFileClipboard(
        stagingRoot: root.appendingPathComponent("clipboard"),
        lifetime: .milliseconds(20),
        publish: { published.record($0) },
        report: { XCTFail("unexpected error: \($0)") })

      clipboard.copy([AssetRef(url: original)])
      await clipboard.copyTask?.value
      let staged = try XCTUnwrap(published.latest.first)
      XCTAssertTrue(FileManager.default.fileExists(atPath: staged.path))
      await clipboard.expiryTask?.value

      XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
      XCTAssertEqual(try Data(contentsOf: original), Data([1, 2, 3]))
    }

    @MainActor
    func testQuittingRemovesEveryStagedCopyAndLeavesTheOriginals() async throws {
      let original = root.appendingPathComponent("photo.dng")
      try Data([1, 2, 3]).write(to: original)
      let staging = root.appendingPathComponent("clipboard")
      let published = Published()
      let center = NotificationCenter()
      let clipboard = AssetFileClipboard(
        stagingRoot: staging,
        publish: { published.record($0) },
        report: { XCTFail("unexpected error: \($0)") },
        notificationCenter: center)
      clipboard.copy([AssetRef(url: original)])
      await clipboard.copyTask?.value
      XCTAssertEqual(try stagedBatches(in: staging).count, 1)

      center.post(name: NSApplication.willTerminateNotification, object: nil)

      XCTAssertTrue(try stagedBatches(in: staging).isEmpty)
      XCTAssertEqual(try Data(contentsOf: original), Data([1, 2, 3]))
    }

    @MainActor
    func testStartingRemovesCopiesAnEarlierRunLeftBehind() throws {
      let staging = root.appendingPathComponent("clipboard")
      let leftover = staging.appendingPathComponent(UUID().uuidString, isDirectory: true)
      let unrelated = staging.appendingPathComponent("keep me", isDirectory: true)
      try FileManager.default.createDirectory(at: leftover, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: true)
      try Data([1]).write(to: leftover.appendingPathComponent("IMG.jpg"))

      _ = AssetFileClipboard(
        stagingRoot: staging, publish: { _ in true }, report: { XCTFail("\($0)") })

      XCTAssertFalse(FileManager.default.fileExists(atPath: leftover.path))
      XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
    }

    @MainActor
    func testRemoteCopyShowsProgressUntilItEnds() async throws {
      let (reported, reportedSignal) = AsyncStream.makeStream(of: Void.self)
      let (release, releaseSignal) = AsyncStream.makeStream(of: Void.self)
      let clipboard = AssetFileClipboard(
        stagingRoot: root.appendingPathComponent("clipboard"),
        publish: { _ in true }, report: { XCTFail("\($0)") })
      let remote = AssetRef(
        displayName: "IMG.jpg", hintExtension: "jpg",
        originalFileWriter: { destination, onProgress in
          onProgress(50, 100)
          reportedSignal.yield()
          for await _ in release { break }
          try Data([1]).write(to: destination)
        },
        bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })

      clipboard.copy([remote])
      XCTAssertNotNil(clipboard.progress)
      for await _ in reported { break }
      while clipboard.progress?.fraction == nil { await Task.yield() }

      XCTAssertEqual(try XCTUnwrap(clipboard.progress?.fraction), 0.5, accuracy: 0.0001)
      releaseSignal.yield()
      await clipboard.copyTask?.value
      XCTAssertNil(clipboard.progress)
    }

    @MainActor
    func testLocalOnlyCopyShowsNoProgress() async throws {
      let original = root.appendingPathComponent("photo.dng")
      try Data([1]).write(to: original)
      let clipboard = AssetFileClipboard(
        stagingRoot: root.appendingPathComponent("clipboard"),
        publish: { _ in true }, report: { XCTFail("\($0)") })

      clipboard.copy([AssetRef(url: original)])

      XCTAssertNil(clipboard.progress)
      await clipboard.copyTask?.value
    }

    @MainActor
    func testCancellingARemoteCopyMidTransferClearsItsProgressAndFiles() async throws {
      let staging = root.appendingPathComponent("clipboard")
      let published = Published()
      let (started, startedSignal) = AsyncStream.makeStream(of: Void.self)
      let clipboard = AssetFileClipboard(
        stagingRoot: staging,
        publish: { published.record($0) }, report: { XCTFail("\($0)") })
      let slow = AssetRef(
        displayName: "IMG.jpg", hintExtension: "jpg",
        originalFileWriter: { destination, _ in
          try Data([1]).write(to: destination)
          startedSignal.yield()
          try await Task.sleep(for: .seconds(30))
        },
        bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })

      clipboard.copy([slow])
      XCTAssertNotNil(clipboard.progress)
      for await _ in started { break }
      XCTAssertEqual(try stagedBatches(in: staging).count, 1, "a partial file exists mid-transfer")
      clipboard.cancelCopy()
      await clipboard.copyTask?.value

      XCTAssertNil(clipboard.progress)
      XCTAssertEqual(published.count, 0)
      XCTAssertTrue(try stagedBatches(in: staging).isEmpty)
    }

    @MainActor
    func testProgressCountsFinishedFilesAndIgnoresALateReport() throws {
      let progress = AssetCopyProgress(fileCount: 4)
      progress.report(received: 50, total: 100, forFile: 0)
      XCTAssertEqual(try XCTUnwrap(progress.fraction), 0.125, accuracy: 0.0001)
      progress.finishFile()
      progress.report(received: 100, total: 100, forFile: 0)
      XCTAssertEqual(try XCTUnwrap(progress.fraction), 0.25, accuracy: 0.0001)
      XCTAssertEqual(progress.title, "Copying 2 of 4 files")
    }

    @MainActor
    func testLoneDownloadWithoutASizeIsIndeterminate() {
      let progress = AssetCopyProgress(fileCount: 1)
      progress.report(received: 10, total: nil, forFile: 0)
      XCTAssertNil(progress.fraction)
      XCTAssertEqual(progress.title, "Copying file")
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
        originalFileWriter: { destination, _ in try bytes.write(to: destination) },
        bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })
    }
  }
#endif
