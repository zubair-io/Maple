// DownloadedFramesStitcher.swift — stitches cloud frames on this device from
// their downloaded copies (#5489).
//
// The merge sheet keeps handing over the cloud frames it shows; this swaps
// each for its cached copy and runs the on-device stitcher. The panorama is
// written beside those copies, inside the cache, so `addToLibrary` moves it
// somewhere lasting before `finished` lets the cache go.

import Foundation
import MapleCloudKit
import os

/// The download that lets cloud frames stitch here, and the stitcher that
/// runs on its copies once they are all cached.
@MainActor
public struct PanoDownloadRoute {
  public let download: PanoFrameDownload
  public let makeStitcher:
    @MainActor (_ cloudFrames: [AssetRef], _ localFrames: [AssetRef]) ->
      any PanoStitching

  public init(
    download: PanoFrameDownload,
    makeStitcher: @escaping @MainActor ([AssetRef], [AssetRef]) -> any PanoStitching
  ) {
    self.download = download
    self.makeStitcher = makeStitcher
  }
}

public final class DownloadedFramesStitcher: PanoStitching {
  private let device: any PanoStitching
  private let localFrames: [UUID: AssetRef]
  private let addToLibrary: @Sendable (PanoResult) async throws -> PanoResult
  private let finished: @MainActor @Sendable () -> Void
  private let cancelled = OSAllocatedUnfairLock(initialState: false)

  /// `cloudFrames` and `localFrames` are the same selection, in order.
  public init(
    device: any PanoStitching,
    cloudFrames: [AssetRef],
    localFrames: [AssetRef],
    addToLibrary: @escaping @Sendable (PanoResult) async throws -> PanoResult,
    finished: @escaping @MainActor @Sendable () -> Void
  ) {
    self.device = device
    self.localFrames = Dictionary(
      uniqueKeysWithValues: zip(cloudFrames.map(\.id), localFrames))
    self.addToLibrary = addToLibrary
    self.finished = finished
  }

  public func preview(
    assets: [AssetRef],
    options: PanoOptions,
    alignment: PanoAlignment?,
    progress: @escaping @MainActor (PanoStage, Double) -> Void
  ) async throws -> PanoPreview {
    try await device.preview(
      assets: local(assets), options: options, alignment: alignment, progress: progress)
  }

  public func stitch(
    assets: [AssetRef],
    options: PanoOptions,
    alignment: PanoAlignment?,
    maxCanvasPixels: Int?,
    progress: @escaping @MainActor (PanoStage, Double) -> Void
  ) async throws -> PanoResult {
    cancelled.withLock { $0 = false }
    let stitched = try await device.stitch(
      assets: local(assets), options: options, alignment: alignment,
      maxCanvasPixels: maxCanvasPixels, progress: progress)
    await progress(.writing, 1)
    if cancelled.withLock({ $0 }) { throw CancellationError() }
    try Task.checkCancellation()
    let added = try await addToLibrary(stitched)
    await finished()
    return added
  }

  public func cancel() {
    cancelled.withLock { $0 = true }
    device.cancel()
  }

  private func local(_ assets: [AssetRef]) throws -> [AssetRef] {
    try assets.map { asset in
      guard let local = localFrames[asset.id] else {
        throw PanoFrameDownloadError.incomplete(asset.displayName)
      }
      return local
    }
  }
}

/// Adds a panorama stitched from downloaded frames to the server library,
/// in a Panoramas folder beside the first frame, where a server stitch puts
/// its own (#5488).
public enum PanoServerUpload {
  public static func add(
    _ result: PanoResult, beside frame: CatalogRef, remote: RemoteCatalog,
    folders: CloudFoldersClient
  ) async throws -> PanoResult {
    let library = try await folders.listFolders().first { $0.id == frame.folderID }
    guard let target = library.flatMap({ uploadPath(for: result, beside: frame, root: $0.path) })
    else {
      throw PanoFrameDownloadError.notOnServer(frame.absPath)
    }
    guard
      case .ok(let uploaded) = try await remote.uploadFile(
        folderID: frame.folderID, targetRelativePath: target, fileURL: result.outputURL,
        mtime: nil)
    else {
      throw PanoFrameDownloadError.uploadRefused(result.outputURL.lastPathComponent)
    }
    return PanoResult(
      outputURL: URL(fileURLWithPath: uploaded.absPath),
      reportSummary: "Stitched on this device and added beside the frames on the server.",
      alignmentOutcome: result.alignmentOutcome,
      matcher: result.matcher,
      serverAssetID: uploaded.assetID,
      storedOnServer: true)
  }

  /// `Panoramas/<name>` beside `frame`, relative to its library's root, which
  /// is what the upload route resolves the path against.
  static func uploadPath(for result: PanoResult, beside frame: CatalogRef, root: String) -> String?
  {
    let prefix = root.hasSuffix("/") ? root : root + "/"
    guard frame.absPath.hasPrefix(prefix) else { return nil }
    let folder =
      (String(frame.absPath.dropFirst(prefix.count)) as NSString)
      .deletingLastPathComponent as NSString
    return folder.appendingPathComponent("Panoramas/\(result.outputURL.lastPathComponent)")
  }
}
