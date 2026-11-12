// DownloadedFramesStitcher.swift — stitches cloud frames on this device from
// their downloaded copies (#5489).
//
// The merge sheet keeps handing over the cloud frames it shows; this swaps
// each for its cached copy and runs the on-device stitcher. The panorama is
// written inside the cache (never beside a local frame), so `addToLibrary`
// moves it somewhere lasting before `finished` lets the cache go.

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
  /// The current run, whether it was stopped, and its upload. A run that is
  /// stopped or superseded has its upload cancelled and never calls
  /// `finished`, which would remove the cache a newer run is reading.
  private let run = OSAllocatedUnfairLock(
    initialState: (id: UInt64(0), cancelled: false, upload: Task<PanoResult, any Error>?.none))

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
    let (id, superseded) = run.withLock { state in
      let superseded = state.upload
      state = (state.id &+ 1, false, nil)
      return (state.id, superseded)
    }
    superseded?.cancel()
    let stitched = try await device.stitch(
      assets: local(assets), options: options, alignment: alignment,
      maxCanvasPixels: maxCanvasPixels, progress: progress)
    await progress(.writing, 1)
    do {
      return try await upload(stitched, run: id)
    } catch {
      if run.withLock({ $0.id != id || $0.cancelled }) {
        try? FileManager.default.removeItem(at: stitched.outputURL)
      }
      throw error
    }
  }

  private func upload(_ stitched: PanoResult, run id: UInt64) async throws -> PanoResult {
    try Task.checkCancellation()
    let addToLibrary = self.addToLibrary
    let upload = Task { try await addToLibrary(stitched) }
    guard run.withLock({ state in
      guard state.id == id, !state.cancelled else { return false }
      state.upload = upload
      return true
    })
    else {
      upload.cancel()
      throw CancellationError()
    }
    let added = try await withTaskCancellationHandler {
      try await upload.value
    } onCancel: {
      upload.cancel()
    }
    // Stop runs on the main actor, so checking there keeps a Stop from
    // landing between the check and the cleanup.
    try await MainActor.run {
      try ensureCurrent(id)
      finished()
    }
    return added
  }

  public func cancel() {
    let upload = run.withLock { state in
      state.cancelled = true
      return state.upload
    }
    upload?.cancel()
    device.cancel()
  }

  private func ensureCurrent(_ id: UInt64) throws {
    if run.withLock({ $0.id != id || $0.cancelled }) { throw CancellationError() }
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
  /// What the server answered for a file it took.
  typealias Uploaded = (absPath: String, assetID: String?)

  public static func add(
    _ result: PanoResult, beside frame: CatalogRef, remote: RemoteCatalog,
    folders: CloudFoldersClient
  ) async throws -> PanoResult {
    let library = try await folders.listFolders().first { $0.id == frame.folderID }
    guard let target = library.flatMap({ uploadPath(for: result, beside: frame, root: $0.path) })
    else {
      throw PanoFrameDownloadError.notOnServer(frame.absPath)
    }
    return try await add(result, target: target) { path, file in
      guard
        case .ok(let uploaded) = try await remote.uploadFile(
          folderID: frame.folderID, targetRelativePath: path, fileURL: file, mtime: nil)
      else { return nil }
      return (uploaded.absPath, uploaded.assetID)
    } remove: { uploaded in
      try await trash(
        assetID: uploaded.assetID, folderID: frame.folderID, path: target, remote: remote)
    }
  }

  /// Uploads the panorama, then the crop sidecar the stitch wrote beside it
  /// (#5608): the PNG is the whole canvas, so without its sidecar the server's
  /// copy would show the empty edges. The sidecar goes second because the
  /// server binds an uploaded sidecar to the photo it belongs to. When the
  /// sidecar does not get there, the panorama just uploaded is removed again
  /// (#5628), so a failed add leaves no uncropped copy for the next try to
  /// duplicate.
  static func add(
    _ result: PanoResult, target: String,
    upload: (String, URL) async throws -> Uploaded?,
    remove: @escaping @Sendable (Uploaded) async throws -> Void
  ) async throws -> PanoResult {
    guard let uploaded = try await upload(target, result.outputURL) else {
      throw PanoFrameDownloadError.uploadRefused(result.outputURL.lastPathComponent)
    }
    let sidecar = SidecarPath.sidecarURL(for: result.outputURL)
    if FileManager.default.fileExists(atPath: sidecar.path) {
      let sidecarTarget = (target as NSString).deletingPathExtension + ".xmp"
      do {
        guard try await upload(sidecarTarget, sidecar) != nil else {
          throw PanoFrameDownloadError.uploadRefused(sidecar.lastPathComponent)
        }
      } catch {
        // In its own task: a Stop cancels this one, and a cancelled task's
        // request fails before it is sent.
        let removal = await Task { try await remove(uploaded) }.result
        guard case .success = removal else {
          throw PanoFrameDownloadError.addedWithoutCrop(
            result.outputURL.lastPathComponent, reason: error.localizedDescription)
        }
        throw error
      }
    }
    return addedResult(from: result, absPath: uploaded.absPath, assetID: uploaded.assetID)
  }

  /// Moves the panorama this run just uploaded to the server's Trash: by the
  /// asset id the upload answered with, or by its path when the server did
  /// not catalogue it.
  private static func trash(
    assetID: String?, folderID: String, path: String, remote: RemoteCatalog
  ) async throws {
    let catalogued: String
    if let assetID {
      catalogued = assetID
    } else if case .indexedAsset(let indexed) = try await remote.deleteFile(
      folderID: folderID, relativePath: path)
    {
      // The indexer catalogued the file after the upload answered.
      catalogued = indexed
    } else {
      return
    }
    switch try await remote.deleteAsset(assetID: catalogued, intent: .trash) {
    case .ok, .stateMismatch(state: "trashed"): return
    case .keptSurvivingCopy, .stateMismatch: throw URLError(.badServerResponse)
    }
  }

  /// The result once its output is on the server: the outcome of the
  /// on-device stitch (alignment, matcher, edge report) is carried over.
  static func addedResult(from result: PanoResult, absPath: String, assetID: String?) -> PanoResult {
    PanoResult(
      outputURL: URL(fileURLWithPath: absPath),
      reportSummary: "Stitched on this device and added beside the frames on the server.",
      alignmentOutcome: result.alignmentOutcome,
      matcher: result.matcher,
      edges: result.edges,
      serverAssetID: assetID,
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
