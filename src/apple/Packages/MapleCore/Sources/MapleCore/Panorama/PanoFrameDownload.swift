// PanoFrameDownload.swift — fetches cloud-only panorama frames into a
// temporary cache so the on-device stitcher can read them (#5489).
//
// The cache is a run directory under Caches/PanoFrames/, never the library:
// originals and library files are only ever read. It is removed when a
// download is cancelled, after the stitch, when the merge sheet closes, and
// on launch, so an app killed mid-run leaves nothing behind for long. A
// failed or stopped download keeps the files it finished, so the next try
// fetches only the rest. Frames already on this device are used in place.

import Foundation
import Network
import os

/// Reads one frame's original from wherever it is stored.
public protocol PanoFrameFetching: Sendable {
  func size(of asset: AssetRef) async throws -> Int64
  /// Writes the original to `destination`, reporting bytes received so far.
  func write(
    _ asset: AssetRef, to destination: URL, progress: @escaping @Sendable (Int64) -> Void
  ) async throws
}

public enum PanoFrameCache {
  public static var root: URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appending(path: "PanoFrames", directoryHint: .isDirectory)
  }

  /// Removes every run an earlier launch left behind.
  public static func sweep(root: URL = root) {
    try? FileManager.default.removeItem(at: root)
  }
}

/// Whether the current network costs the user money or data allowance.
public struct PanoNetworkCost: Equatable, Sendable {
  /// Cellular or a personal hotspot.
  public let expensive: Bool
  /// Low Data Mode is on.
  public let constrained: Bool

  public init(expensive: Bool, constrained: Bool) {
    self.expensive = expensive
    self.constrained = constrained
  }

  public static func current() async -> PanoNetworkCost {
    await withCheckedContinuation { continuation in
      let monitor = NWPathMonitor()
      let resumed = OSAllocatedUnfairLock(initialState: false)
      monitor.pathUpdateHandler = { path in
        guard
          resumed.withLock({ done in
            defer { done = true }
            return !done
          })
        else { return }
        monitor.cancel()
        continuation.resume(
          returning: PanoNetworkCost(expensive: path.isExpensive, constrained: path.isConstrained))
      }
      monitor.start(queue: .global(qos: .userInitiated))
    }
  }
}

public struct PanoDownloadEstimate: Equatable, Sendable {
  public let totalBytes: Int64
  /// Already in the cache from an earlier attempt; not fetched again.
  public let cachedBytes: Int64
  /// Free space on the cache's volume; `nil` when the system won't say.
  public let freeBytes: Int64?
  public let network: PanoNetworkCost

  /// Room left over for the stitch's output: a full 256 MP panorama is a
  /// 16-bit PNG of up to 1.5 GiB, plus its preview sidecars.
  public static let headroomBytes: Int64 = 3 << 30

  public var remainingBytes: Int64 { totalBytes - cachedBytes }
  public var fits: Bool { freeBytes.map { $0 >= remainingBytes + Self.headroomBytes } ?? true }
}

public struct PanoDownloadProgress: Equatable, Sendable {
  public let fileIndex: Int
  public let fileCount: Int
  public let fileName: String
  public let fileReceived: Int64
  public let fileTotal: Int64
  public let receivedBytes: Int64
  public let totalBytes: Int64

  public var fileFraction: Double { Self.fraction(fileReceived, fileTotal) }
  public var overallFraction: Double { Self.fraction(receivedBytes, totalBytes) }

  private static func fraction(_ part: Int64, _ whole: Int64) -> Double {
    whole > 0 ? min(Double(part) / Double(whole), 1) : 1
  }
}

@MainActor
@Observable
public final class PanoFrameDownload {
  public enum State: Equatable, Sendable {
    case idle
    case estimating
    case ready(PanoDownloadEstimate)
    case downloading(PanoDownloadProgress)
    case downloaded
    case failed(String)
  }

  public private(set) var state: State = .idle
  /// The cached frames, in the selection's order, once every one is here.
  public private(set) var localAssets: [AssetRef]?

  private let fetcher: any PanoFrameFetching
  private let directory: URL
  private let networkCost: @Sendable () async -> PanoNetworkCost
  private var assets: [AssetRef] = []
  private var sizes: [Int64] = []
  private var task: Task<Void, Never>?
  private var generation: UInt64 = 0

  public init(
    fetcher: any PanoFrameFetching,
    root: URL = PanoFrameCache.root,
    networkCost: @escaping @Sendable () async -> PanoNetworkCost = PanoNetworkCost.current
  ) {
    self.fetcher = fetcher
    self.directory = root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    self.networkCost = networkCost
  }

  /// Sizes the frames, checks the cache, free space and the network.
  public func estimate(_ assets: [AssetRef]) {
    let run = restart()
    self.assets = assets
    localAssets = nil
    state = .estimating
    let fetcher = self.fetcher
    task = Task {
      do {
        let sizes = try await Self.sizes(of: assets, fetcher: fetcher)
        let network = await networkCost()
        guard run == generation else { return }
        self.sizes = sizes
        let cached = assets.indices.filter(isCached).map { sizes[$0] }.reduce(0, +)
        state = .ready(
          PanoDownloadEstimate(
            totalBytes: sizes.reduce(0, +), cachedBytes: cached, freeBytes: freeBytes(),
            network: network))
      } catch {
        fail(run, error, doing: "check the frames’ sizes")
      }
    }
  }

  /// Downloads whatever the estimate found missing. Only from `.ready`, and
  /// only when the frames fit.
  public func start() {
    guard case .ready(let estimate) = state, estimate.fits else { return }
    let run = restart()
    let total = estimate.totalBytes
    task = Task {
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var received: Int64 = 0
        for index in assets.indices {
          if !isCached(index) {
            try await fetch(index, run: run, receivedBefore: received, total: total)
          }
          received += sizes[index]
        }
        guard run == generation else { return }
        localAssets = assets.indices.map { index in
          assets[index].primaryURL == nil ? AssetRef(url: fileURL(for: index)) : assets[index]
        }
        state = .downloaded
      } catch {
        fail(run, error, doing: "download the frames")
      }
    }
  }

  /// Stops any download, keeping the frames already cached for a later try.
  public func stop() {
    restart()
    if state != .downloaded { state = .idle }
  }

  /// Stops any download and removes everything this run cached.
  public func cancel() {
    restart()
    try? FileManager.default.removeItem(at: directory)
    localAssets = nil
    state = .idle
  }

  // MARK: - Private

  @discardableResult
  private func restart() -> UInt64 {
    generation &+= 1
    task?.cancel()
    task = nil
    return generation
  }

  private func fetch(_ index: Int, run: UInt64, receivedBefore: Int64, total: Int64) async throws {
    let asset = assets[index]
    let destination = fileURL(for: index)
    let partial = destination.appendingPathExtension("partial")
    let fileManager = FileManager.default
    try fileManager.createDirectory(
      at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? fileManager.removeItem(at: partial)
    let latest = OSAllocatedUnfairLock<Int64>(initialState: 0)
    // A tick already queued when this file finishes must not overwrite
    // the state the caller sets next.
    let fileDone = OSAllocatedUnfairLock(initialState: false)
    let publish = { [weak self] in
      guard let self, run == self.generation, !fileDone.withLock({ $0 }) else { return }
      self.state = .downloading(
        PanoDownloadProgress(
          fileIndex: index, fileCount: self.assets.count, fileName: asset.displayName,
          fileReceived: latest.withLock { $0 }, fileTotal: self.sizes[index],
          receivedBytes: receivedBefore + latest.withLock { $0 }, totalBytes: total))
    }
    publish()
    let ticker = Task { @MainActor in
      while (try? await Task.sleep(for: .milliseconds(200))) != nil {
        publish()
      }
    }
    defer {
      fileDone.withLock { $0 = true }
      ticker.cancel()
    }
    do {
      try await fetcher.write(asset, to: partial) { bytes in latest.withLock { $0 = bytes } }
      try Task.checkCancellation()
      guard Self.fileSize(partial) == sizes[index] else {
        throw PanoFrameDownloadError.incomplete(asset.displayName)
      }
      try fileManager.moveItem(at: partial, to: destination)
    } catch {
      try? fileManager.removeItem(at: partial)
      throw error
    }
  }

  private func fail(_ run: UInt64, _ error: any Error, doing action: String) {
    guard run == generation else { return }
    state =
      error is CancellationError
      ? .idle
      : .failed("Couldn’t \(action): \(error.localizedDescription)")
  }

  /// Each frame gets its own directory, so two frames from different
  /// folders with the same name can't collide.
  private func fileURL(for index: Int) -> URL {
    directory.appending(path: "\(index)", directoryHint: .isDirectory)
      .appending(path: assets[index].displayName)
  }

  private func isCached(_ index: Int) -> Bool {
    assets[index].primaryURL != nil || Self.fileSize(fileURL(for: index)) == sizes[index]
  }

  private func freeBytes() -> Int64? {
    let probe = directory.deletingLastPathComponent().deletingLastPathComponent()
    let values = try? probe.resourceValues(forKeys: [
      .volumeAvailableCapacityForImportantUsageKey
    ])
    return values?.volumeAvailableCapacityForImportantUsage
  }

  private static func fileSize(_ url: URL) -> Int64? {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
  }

  private static func sizes(of assets: [AssetRef], fetcher: any PanoFrameFetching) async throws
    -> [Int64]
  {
    try await withThrowingTaskGroup(of: (Int, Int64).self) { group in
      for (index, asset) in assets.enumerated() where asset.primaryURL == nil {
        group.addTask { (index, try await fetcher.size(of: asset)) }
      }
      var sizes = [Int64](repeating: 0, count: assets.count)
      for try await (index, size) in group { sizes[index] = size }
      return sizes
    }
  }
}

public enum PanoFrameDownloadError: Error, LocalizedError, Equatable {
  case incomplete(String)
  case notOnServer(String)
  case uploadRefused(String)

  public var errorDescription: String? {
    switch self {
    case .incomplete(let name): return "\(name) didn’t download completely."
    case .notOnServer(let name): return "\(name) isn’t on a Maple server."
    case .uploadRefused(let name): return "The server wouldn’t take \(name)."
    }
  }
}

/// Fetches frames from the Maple servers that hold them.
public struct CloudPanoFrameFetcher: PanoFrameFetching {
  private let sources: [URL: CloudSource]

  /// `sources` by each frame's `CatalogRef.serverID`.
  public init(sources: [URL: CloudSource]) {
    self.sources = sources
  }

  public func size(of asset: AssetRef) async throws -> Int64 {
    let (source, ref) = try locate(asset)
    guard let size = try await source.originalSize(for: ref) else {
      throw PanoFrameDownloadError.incomplete(asset.displayName)
    }
    return size
  }

  public func write(
    _ asset: AssetRef, to destination: URL, progress: @escaping @Sendable (Int64) -> Void
  ) async throws {
    let (source, ref) = try locate(asset)
    try await source.writeOriginal(for: ref, to: destination) { received, _ in progress(received) }
  }

  private func locate(_ asset: AssetRef) throws -> (CloudSource, ImageRef) {
    guard let catalog = asset.catalog, let source = sources[catalog.serverID] else {
      throw PanoFrameDownloadError.notOnServer(asset.displayName)
    }
    return (source, ImageRef(id: "fs:\(catalog.absPath)", displayName: asset.displayName, url: nil))
  }
}
