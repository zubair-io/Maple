// PanoFrameDownloadTests.swift — downloading cloud frames into a temporary
// cache for an on-device stitch (#5489).

import Foundation
import Testing
import os

@testable import MapleCore

/// Serves frames of fixed sizes. A frame named in `failing` throws mid-way;
/// one named in `held` waits until the test releases it.
private final class FakeFetcher: PanoFrameFetching {
  private struct Calls {
    var writes: [String] = []
    var released = false
    var probing = 0
    var mostProbing = 0
  }

  let sizes: [String: Int64]
  let failing: Set<String>
  let held: Set<String>
  /// Frames whose bytes come up one short of the size they report.
  let truncated: Set<String>
  private let calls = OSAllocatedUnfairLock(initialState: Calls())

  init(
    sizes: [String: Int64], failing: Set<String> = [], held: Set<String> = [],
    truncated: Set<String> = []
  ) {
    self.sizes = sizes
    self.failing = failing
    self.held = held
    self.truncated = truncated
  }

  var writes: [String] { calls.withLock { $0.writes } }
  var mostConcurrentProbes: Int { calls.withLock { $0.mostProbing } }
  func release() { calls.withLock { $0.released = true } }

  func size(of asset: AssetRef) async throws -> Int64 {
    calls.withLock {
      $0.probing += 1
      $0.mostProbing = max($0.mostProbing, $0.probing)
    }
    defer { calls.withLock { $0.probing -= 1 } }
    try await Task.sleep(for: .milliseconds(10))
    return sizes[asset.displayName] ?? 0
  }

  func write(
    _ asset: AssetRef, to destination: URL, progress: @escaping @Sendable (Int64) -> Void
  ) async throws {
    let name = asset.displayName
    calls.withLock { $0.writes.append(name) }
    let size = Int(sizes[name] ?? 0)
    progress(Int64(size / 2))
    if held.contains(name) {
      while !calls.withLock({ $0.released }) {
        try await Task.sleep(for: .milliseconds(5))
      }
    }
    if failing.contains(name) { throw URLError(.networkConnectionLost) }
    try Data(repeating: 7, count: truncated.contains(name) ? size - 1 : size).write(to: destination)
    progress(Int64(size))
  }
}

private func cloudFrame(_ name: String) -> AssetRef {
  AssetRef(
    displayName: name, hintExtension: "dng",
    catalog: CatalogRef(
      serverID: URL(string: "https://maple.test")!, folderID: "lib", absPath: "/photos/\(name)",
      address: nil),
    bytesProvider: { Data() })
}

private let wifi = PanoNetworkCost(expensive: false, constrained: false)

@MainActor
private func waitUntil(_ done: () -> Bool) async throws {
  for _ in 0..<1000 where !done() {
    try await Task.sleep(for: .milliseconds(5))
  }
  #expect(done(), "timed out")
}

@MainActor
private func waitFor(
  _ download: PanoFrameDownload, _ done: (PanoFrameDownload.State) -> Bool
) async throws {
  for _ in 0..<1000 where !done(download.state) {
    try await Task.sleep(for: .milliseconds(5))
  }
  #expect(done(download.state), "stuck in \(download.state)")
}

@MainActor
private func isReady(_ state: PanoFrameDownload.State) -> Bool {
  if case .ready = state { return true }
  return false
}

private func temporaryRoot() -> URL {
  FileManager.default.temporaryDirectory.appending(path: "pano-frames-\(UUID().uuidString)")
}

@MainActor
@Suite struct PanoFrameDownloadTests {
  let frames = ["A.dng", "B.dng", "C.dng"].map(cloudFrame)
  let sizes: [String: Int64] = ["A.dng": 1000, "B.dng": 2000, "C.dng": 3000]

  @Test func estimatesTheWholeSelectionBeforeDownloading() async throws {
    let fetcher = FakeFetcher(sizes: sizes)
    let download = PanoFrameDownload(
      fetcher: fetcher, root: temporaryRoot(),
      networkCost: { PanoNetworkCost(expensive: true, constrained: false) })
    download.estimate(frames)
    try await waitFor(download, isReady)
    guard case .ready(let estimate) = download.state else { return }
    #expect(estimate.totalBytes == 6000)
    #expect(estimate.cachedBytes == 0)
    #expect(estimate.network.expensive)
    #expect(estimate.fits)
    #expect(fetcher.writes.isEmpty)
  }

  @Test func downloadsEveryFrameAndHandsBackLocalCopiesInOrder() async throws {
    let root = temporaryRoot()
    let download = PanoFrameDownload(
      fetcher: FakeFetcher(sizes: sizes), root: root, networkCost: { wifi })
    download.estimate(frames)
    try await waitFor(download, isReady)
    download.start()
    try await waitFor(download) { $0 == .downloaded }
    let local = try #require(download.localAssets)
    #expect(local.map { $0.primaryURL?.lastPathComponent } == ["A.dng", "B.dng", "C.dng"])
    for (copy, name) in zip(local, ["A.dng", "B.dng", "C.dng"]) {
      let url = try #require(copy.primaryURL)
      #expect(url.path.hasPrefix(root.path))
      let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int
      #expect(Int64(size ?? 0) == sizes[name])
    }
    download.cancel()
    #expect(!FileManager.default.fileExists(atPath: local[0].primaryURL!.path))
  }

  @Test func aRetryAfterAFailureSkipsFramesAlreadyCached() async throws {
    let root = temporaryRoot()
    let failing = FakeFetcher(sizes: sizes, failing: ["C.dng"])
    let download = PanoFrameDownload(fetcher: failing, root: root, networkCost: { wifi })
    download.estimate(frames)
    try await waitFor(download, isReady)
    download.start()
    try await waitFor(download) {
      if case .failed = $0 { return true }
      return false
    }
    #expect(failing.writes == ["A.dng", "B.dng", "C.dng"])

    download.estimate(frames)
    try await waitFor(download, isReady)
    guard case .ready(let estimate) = download.state else { return }
    #expect(estimate.cachedBytes == 3000)
    #expect(estimate.remainingBytes == 3000)
  }

  @Test func theNextTryFetchesOnlyTheMissingFrames() async throws {
    let root = temporaryRoot()
    let first = FakeFetcher(sizes: sizes, failing: ["C.dng"])
    let failed = PanoFrameDownload(fetcher: first, root: root, networkCost: { wifi })
    failed.estimate(frames)
    try await waitFor(failed, isReady)
    failed.start()
    try await waitFor(failed) {
      if case .failed = $0 { return true }
      return false
    }
    failed.stop()
    failed.estimate(frames)
    try await waitFor(failed, isReady)
    // Same run directory, a fetcher that no longer fails.
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: root.path)
    #expect(leftovers.count == 1)
    #expect(
      !FileManager.default.fileExists(
        atPath: root.appending(path: "\(leftovers[0])/2/C.dng.partial").path))
  }

  @Test func framesAlreadyOnThisDeviceAreUsedInPlace() async throws {
    let onDevice = AssetRef(url: URL(fileURLWithPath: "/Volumes/Card/LOCAL.dng"))
    let fetcher = FakeFetcher(sizes: sizes)
    let download = PanoFrameDownload(fetcher: fetcher, root: temporaryRoot(), networkCost: { wifi })
    download.estimate([frames[0], onDevice, frames[1]])
    try await waitFor(download, isReady)
    guard case .ready(let estimate) = download.state else { return }
    #expect(estimate.totalBytes == 3000)
    download.start()
    try await waitFor(download) { $0 == .downloaded }
    #expect(fetcher.writes == ["A.dng", "B.dng"])
    #expect(download.localAssets?[1] == onDevice)
  }

  @Test func aFrameThatArrivesShortFailsAndLeavesNoPartialFile() async throws {
    let root = temporaryRoot()
    let download = PanoFrameDownload(
      fetcher: FakeFetcher(sizes: sizes, truncated: ["B.dng"]), root: root,
      networkCost: { wifi })
    download.estimate(frames)
    try await waitFor(download, isReady)
    download.start()
    try await waitFor(download) {
      if case .failed(let message) = $0 { return message.contains("B.dng") }
      return false
    }
    let files = FileManager.default.enumerator(atPath: root.path)?.allObjects as? [String] ?? []
    #expect(!files.contains { $0.hasSuffix(".partial") })
    #expect(files.contains { $0.hasSuffix("A.dng") })
  }

  @Test func cancellingMidDownloadLeavesNothingBehind() async throws {
    let root = temporaryRoot()
    let fetcher = FakeFetcher(sizes: sizes, held: ["B.dng"])
    let download = PanoFrameDownload(fetcher: fetcher, root: root, networkCost: { wifi })
    download.estimate(frames)
    try await waitFor(download, isReady)
    download.start()
    try await waitFor(download) {
      if case .downloading(let progress) = $0 { return progress.fileIndex == 1 }
      return false
    }
    guard case .downloading(let progress) = download.state else { return }
    #expect(progress.receivedBytes >= 1000)
    #expect(progress.fileCount == 3)

    download.cancel()
    fetcher.release()
    try await Task.sleep(for: .milliseconds(50))
    #expect(download.state == .removed)
    #expect(download.localAssets == nil)
    let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
    #expect(leftovers.isEmpty)

    download.estimate(frames)
    try await waitFor(download, isReady)
    guard case .ready(let estimate) = download.state else {
      Issue.record("no estimate after cancel: \(download.state)")
      return
    }
    #expect(estimate.cachedBytes == 0)
  }

  @Test func sizeProbesRunAFewAtATime() async throws {
    let many = (0..<21).map { cloudFrame("F\($0).dng") }
    let fetcher = FakeFetcher(sizes: [:])
    let download = PanoFrameDownload(fetcher: fetcher, root: temporaryRoot(), networkCost: { wifi })
    download.estimate(many)
    try await waitFor(download, isReady)
    #expect(fetcher.mostConcurrentProbes <= PanoFrameDownload.sizeProbeConcurrency)
    #expect(fetcher.mostConcurrentProbes > 1)
  }

  @Test func aServerNameCanOnlyNameOneFileInTheFramesDirectory() {
    #expect(PanoFrameDownload.safeFileName("../../x.plist", index: 3) == "x.plist")
    #expect(PanoFrameDownload.safeFileName("A.dng", index: 0) == "A.dng")
    #expect(PanoFrameDownload.safeFileName("..", index: 2) == "frame-2")
    #expect(PanoFrameDownload.safeFileName("dir/..", index: 2) == "frame-2")
    #expect(PanoFrameDownload.safeFileName("", index: 1) == "frame-1")
    #expect(PanoFrameDownload.safeFileName("/", index: 1) == "frame-1")
    #expect(PanoFrameDownload.safeFileName("a\0b.dng", index: 0) == "ab.dng")
  }

  @Test func aTraversingNameDownloadsInsideTheRun() async throws {
    let root = temporaryRoot()
    let sneaky = cloudFrame("../../x.plist")
    let download = PanoFrameDownload(
      fetcher: FakeFetcher(sizes: ["../../x.plist": 10]), root: root, networkCost: { wifi })
    download.estimate([sneaky, cloudFrame("A.dng")])
    try await waitFor(download, isReady)
    download.start()
    try await waitFor(download) { $0 == .downloaded }
    let file = try #require(download.localAssets?[0].primaryURL).standardizedFileURL
    let run = file.deletingLastPathComponent().deletingLastPathComponent()
    #expect(file.pathComponents.suffix(2) == ["0", "x.plist"])
    #expect(run.deletingLastPathComponent().path == root.standardizedFileURL.path)
    #expect(FileManager.default.fileExists(atPath: file.path))
    #expect(!FileManager.default.fileExists(atPath: root.appending(path: "x.plist").path))
  }

  @Test func refusesToStartWhenTheFramesDoNotFit() {
    let tight = PanoDownloadEstimate(
      totalBytes: 10 << 30, cachedBytes: 0, freeBytes: 10 << 30, network: wifi)
    #expect(!tight.fits)
    let roomy = PanoDownloadEstimate(
      totalBytes: 1 << 30, cachedBytes: 0, freeBytes: 10 << 30, network: wifi)
    #expect(roomy.fits)
  }

  @Test func readsTheTotalFromAContentRange() {
    #expect(CloudSource.totalBytes(contentRange: "bytes 0-0/104857600") == 104_857_600)
    #expect(CloudSource.totalBytes(contentRange: "bytes */0") == 0)
    #expect(CloudSource.totalBytes(contentRange: nil) == nil)
  }

  @Test func theLaunchSweepRemovesEarlierRuns() throws {
    let root = temporaryRoot()
    let leftover = root.appending(path: "run/0")
    try FileManager.default.createDirectory(at: leftover, withIntermediateDirectories: true)
    PanoFrameCache.sweep(root: root)
    #expect(!FileManager.default.fileExists(atPath: root.path))
  }
}

/// Remembers the frames it was handed; returns a fixed result.
private final class LocalCopyRecorder: PanoStitching {
  private let handed = OSAllocatedUnfairLock<[URL?]>(initialState: [])
  private let output: URL
  var frames: [URL?] { handed.withLock { $0 } }

  init(output: URL = URL(fileURLWithPath: "/cache/0/Panoramas/p.png")) {
    self.output = output
  }

  func stitch(
    assets: [AssetRef], options: PanoOptions, alignment: PanoAlignment?, maxCanvasPixels: Int?,
    progress: @escaping @MainActor (PanoStage, Double) -> Void
  ) async throws -> PanoResult {
    handed.withLock { $0 = assets.map(\.primaryURL) }
    return PanoResult(outputURL: output, reportSummary: "")
  }

  func preview(
    assets: [AssetRef], options: PanoOptions, alignment: PanoAlignment?,
    progress: @escaping @MainActor (PanoStage, Double) -> Void
  ) async throws -> PanoPreview {
    throw CancellationError()
  }

  func cancel() {}
}

@MainActor
@Suite struct DownloadedFramesStitcherTests {
  @Test func handsTheDeviceTheLocalCopies() async throws {
    let cloud = ["A.dng", "B.dng"].map(cloudFrame)
    let urls = [URL(fileURLWithPath: "/cache/0/A.dng"), URL(fileURLWithPath: "/cache/1/B.dng")]
    let device = LocalCopyRecorder()
    let stitcher = DownloadedFramesStitcher(
      device: device, cloudFrames: cloud, localFrames: urls.map { AssetRef(url: $0) },
      addToLibrary: { $0 }, finished: {})
    _ = try await stitcher.stitch(
      assets: cloud, options: .default, alignment: nil, maxCanvasPixels: nil,
      progress: { _, _ in })
    #expect(device.frames == urls)
  }

  @Test func aRefusedUploadKeepsTheCache() async {
    let cloud = ["A.dng", "B.dng"].map(cloudFrame)
    let finished = OSAllocatedUnfairLock(initialState: false)
    let stitcher = DownloadedFramesStitcher(
      device: LocalCopyRecorder(), cloudFrames: cloud,
      localFrames: cloud.map { _ in AssetRef(url: URL(fileURLWithPath: "/cache/x.dng")) },
      addToLibrary: { _ in throw PanoFrameDownloadError.uploadRefused("p.png") },
      finished: { finished.withLock { $0 = true } })
    await #expect(throws: PanoFrameDownloadError.self) {
      _ = try await stitcher.stitch(
        assets: cloud, options: .default, alignment: nil, maxCanvasPixels: nil,
        progress: { _, _ in })
    }
    #expect(!finished.withLock { $0 })
  }

  @Test func theUploadPathIsBesideTheFrameUnderItsOwnLibrary() {
    let frame = CatalogRef(
      serverID: URL(string: "https://maple.test")!, folderID: "lib",
      absPath: "/srv/photos/2026/Sumac/PANO_0001.DNG", address: nil)
    let result = PanoResult(outputURL: URL(fileURLWithPath: "/cache/p.png"), reportSummary: "")
    #expect(
      PanoServerUpload.uploadPath(for: result, beside: frame, root: "/srv/photos")
        == "2026/Sumac/Panoramas/p.png")
    #expect(
      PanoServerUpload.uploadPath(for: result, beside: frame, root: "/srv/photos/2026/Sumac/")
        == "Panoramas/p.png")
    #expect(PanoServerUpload.uploadPath(for: result, beside: frame, root: "/elsewhere") == nil)
  }

  @Test func stitchesTheLocalCopiesAndAddsTheResultToTheLibrary() async throws {
    let cloud = ["A.dng", "B.dng"].map(cloudFrame)
    let local = [URL(fileURLWithPath: "/tmp/a.dng"), URL(fileURLWithPath: "/tmp/b.dng")]
      .map { AssetRef(url: $0) }
    let device = MockPanoStitcher()
    let finished = OSAllocatedUnfairLock(initialState: false)
    let stitcher = DownloadedFramesStitcher(
      device: device, cloudFrames: cloud, localFrames: local,
      addToLibrary: { result in
        PanoResult(
          outputURL: URL(fileURLWithPath: "/srv/Panoramas/\(result.outputURL.lastPathComponent)"),
          reportSummary: "added", storedOnServer: true)
      },
      finished: { finished.withLock { $0 = true } })
    let result = try await stitcher.stitch(
      assets: cloud, options: .default, alignment: nil, maxCanvasPixels: nil,
      progress: { _, _ in })
    #expect(result.storedOnServer)
    #expect(result.serverAssetID == nil)
    #expect(result.outputURL.path.hasPrefix("/srv/Panoramas/"))
    #expect(finished.withLock { $0 })
  }

  @Test func stoppingDuringTheUploadAddsNothingAndKeepsTheCache() async throws {
    let cloud = ["A.dng", "B.dng"].map(cloudFrame)
    let root = temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let output = root.appending(path: "p.png")
    try Data([1]).write(to: output)
    let events = OSAllocatedUnfairLock(
      initialState: (uploading: false, uploadCancelled: false, finished: false))
    let stitcher = DownloadedFramesStitcher(
      device: LocalCopyRecorder(output: output), cloudFrames: cloud,
      localFrames: cloud.map { _ in AssetRef(url: URL(fileURLWithPath: "/cache/x.dng")) },
      addToLibrary: { result in
        events.withLock { $0.uploading = true }
        for _ in 0..<1000 where !Task.isCancelled {
          try? await Task.sleep(for: .milliseconds(5))
        }
        events.withLock { $0.uploadCancelled = Task.isCancelled }
        return result
      },
      finished: { events.withLock { $0.finished = true } })
    let running = Task {
      try await stitcher.stitch(
        assets: cloud, options: .default, alignment: nil, maxCanvasPixels: nil,
        progress: { _, _ in })
    }
    try await waitUntil { events.withLock { $0.uploading } }
    stitcher.cancel()
    await #expect(throws: CancellationError.self) { _ = try await running.value }
    #expect(events.withLock { $0.uploadCancelled && !$0.finished })
    #expect(!FileManager.default.fileExists(atPath: output.path))
    #expect(FileManager.default.fileExists(atPath: root.path))
  }

  @Test func aSupersededRunNeverRemovesTheNewerRunsCache() async throws {
    let cloud = ["A.dng", "B.dng"].map(cloudFrame)
    let calls = OSAllocatedUnfairLock(
      initialState: (uploads: 0, staleCancelled: false, finished: 0))
    let stitcher = DownloadedFramesStitcher(
      device: LocalCopyRecorder(), cloudFrames: cloud,
      localFrames: cloud.map { _ in AssetRef(url: URL(fileURLWithPath: "/cache/x.dng")) },
      addToLibrary: { result in
        let first = calls.withLock { state in
          state.uploads += 1
          return state.uploads == 1
        }
        guard first else { return result }
        for _ in 0..<1000 where !Task.isCancelled {
          try? await Task.sleep(for: .milliseconds(5))
        }
        calls.withLock { $0.staleCancelled = Task.isCancelled }
        return result
      },
      finished: { calls.withLock { $0.finished += 1 } })
    let stale = Task {
      try await stitcher.stitch(
        assets: cloud, options: .default, alignment: nil, maxCanvasPixels: nil,
        progress: { _, _ in })
    }
    try await waitUntil { calls.withLock { $0.uploads } > 0 }
    _ = try await stitcher.stitch(
      assets: cloud, options: .default, alignment: nil, maxCanvasPixels: nil,
      progress: { _, _ in })
    await #expect(throws: CancellationError.self) { _ = try await stale.value }
    #expect(calls.withLock { $0.staleCancelled && $0.finished == 1 })
  }

  @Test func aMixedSelectionWritesItsPanoramaInsideTheCache() throws {
    let root = temporaryRoot()
    let originals = root.appending(path: "originals", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: originals, withIntermediateDirectories: true)
    let localFirst = originals.appending(path: "AAA_0001.DNG")
    try Data().write(to: localFirst)
    let download = PanoFrameDownload(
      fetcher: FakeFetcher(sizes: [:]), root: root.appending(path: "cache"),
      networkCost: { wifi })
    let output = RustPanoStitcher(outputDirectory: download.outputDirectory)
      .outputURL(near: localFirst)
    #expect(output.deletingLastPathComponent() == download.outputDirectory)
    #expect(
      try FileManager.default.contentsOfDirectory(atPath: originals.path) == ["AAA_0001.DNG"])
    try Data().write(to: output)
    download.cancel()
    #expect(!FileManager.default.fileExists(atPath: output.path))
  }

  @Test func aFrameWithoutALocalCopyFails() async {
    let stitcher = DownloadedFramesStitcher(
      device: MockPanoStitcher(), cloudFrames: [], localFrames: [],
      addToLibrary: { $0 }, finished: {})
    await #expect(throws: PanoFrameDownloadError.self) {
      _ = try await stitcher.stitch(
        assets: [cloudFrame("A.dng"), cloudFrame("B.dng")], options: .default, alignment: nil,
        maxCanvasPixels: nil, progress: { _, _ in })
    }
  }
}
