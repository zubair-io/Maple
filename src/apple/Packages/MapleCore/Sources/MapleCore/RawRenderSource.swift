import Foundation

/// A session-owned file for the path-only Auto Profile FFI (#3357).
/// Remote bytes are staged once, off the main actor; concurrent CPU/GPU/export
/// callers share the same task. No user file or sidecar is written here.
actor RawRenderSource {
  private let originalAsset: AssetRef?
  private var pending: Task<StagedFile, Error>?
  // Keep an owner-side cleanup handle as well as the task result. A completed
  // Task can retain its result briefly after the actor is released, so relying
  // only on StagedFile.deinit makes session teardown nondeterministic.
  private var stagedDirectory: URL?

  init(asset: AssetRef? = nil) { originalAsset = asset }

  func url(for asset: AssetRef) async throws -> URL {
    // The bound asset carries the source's original provider. The editor's
    // public asset wraps that provider through this staging actor; using the
    // wrapper here would recursively wait for our own pending task.
    let asset = originalAsset ?? asset
    if let url = asset.primaryURL { return url }
    try Task.checkCancellation()
    if let pending { return try await pending.value.url }
    guard let provider = asset.bytesProvider else { throw RenderError.pipelineFailed }
    let task = Task.detached(priority: .userInitiated) {
      let bytes = try await provider()
      try Task.checkCancellation()
      let file = try StagedFile(extensionHint: asset.hintExtension)
      try bytes.write(to: file.url, options: .atomic)
      return file
    }
    pending = task
    do {
      let file = try await task.value
      stagedDirectory = file.directory
      return file.url
    } catch {
      pending = nil
      throw error
    }
  }

  /// Returns the staged file URL if already available or actively staging,
  /// without initiating a new remote fetch.
  func stagedURLIfAvailable(for asset: AssetRef) async -> URL? {
    let asset = originalAsset ?? asset
    if let url = asset.primaryURL { return url }
    guard let pending else { return nil }
    return try? await pending.value.url
  }

  /// Metadata, decode and profile fitting share one download and one staged
  /// file. Mapping avoids retaining an additional full-RAW Data cache across
  /// the session; consumers release their mapping when their work completes.
  func bytes(for asset: AssetRef) async throws -> Data {
    let url = try await url(for: asset)
    try Task.checkCancellation()
    return try Data(contentsOf: url, options: .mappedIfSafe)
  }

  deinit {
    pending?.cancel()
    if let stagedDirectory {
      try? FileManager.default.removeItem(at: stagedDirectory)
    }
  }

  /// Ownership follows the task result, including a completion after teardown.
  /// Releasing the session releases its staged copy; the original is untouched.
  private final class StagedFile: Sendable {
    let directory: URL
    let url: URL

    init(extensionHint: String?) throws {
      directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-render-\(UUID().uuidString)", isDirectory: true)
      let suffix = (extensionHint ?? "").filter { $0.isLetter || $0.isNumber }
      url = directory.appendingPathComponent("original").appendingPathExtension(suffix)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: directory) }
  }
}
