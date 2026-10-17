// RenderedPreviewCache.swift — Per-asset JPEG preview cache.
//
// Key components (per spec § 05):
//   primaryURL hash
//   primary mtime (the RAW file's own last-modified timestamp, #1928)
//   sidecar mtime (XMP last-modified timestamp)
//   screen size (integer width class)
//
// No pipeline or view-transform version participates (#4793): a pipeline bump
// never invalidates a preview. The settled canvas always comes from the live
// pipeline (#4255); a hit only seeds the cold-open paint.
//
// Storage: .maple/previews/<key>.jpg
// Entries are invalidated on any key component change.

import CoreImage
import CryptoKit
import Foundation
import OSLog

private let cacheLog = Logger(subsystem: "app.justmaple.aperture", category: "RenderedPreviewCache")

// MARK: - RenderedPreviewCache

public actor RenderedPreviewCache {
  public static let shared = RenderedPreviewCache()

  private let fm = FileManager.default
  private var cacheDir: URL?
  private var memCache: [String: (CIImage, Date)] = [:]  // (image, stored-at)
  private let maxMemEntries = 20

  // MARK: - Configure

  public func configure(folderURL: URL) {
    let mapleDir = folderURL.appendingPathComponent(".maple")
    let previewDir = mapleDir.appendingPathComponent("previews")
    try? fm.createDirectory(at: previewDir, withIntermediateDirectories: true)
    cacheDir = previewDir
  }

  // MARK: - Read

  public func preview(for assetURL: URL, screenWidth: Int, sidecarURL: URL? = nil) -> CIImage? {
    let key = cacheKey(for: assetURL, screenWidth: screenWidth, sidecarURL: sidecarURL)
    // Memory
    if let (img, _) = memCache[key] {
      cacheLog.notice(
        "RenderedPreviewCache: MEMORY HIT \(assetURL.lastPathComponent, privacy: .public) — SKIPPING Rust pipeline"
      )
      return img
    }
    // Disk
    guard let dir = cacheDir else {
      cacheLog.notice("RenderedPreviewCache: no cacheDir configured")
      return nil
    }
    let fileURL = dir.appendingPathComponent("\(key).jpg")
    guard fm.fileExists(atPath: fileURL.path),
      let data = try? Data(contentsOf: fileURL),
      let ci = CIImage(data: data)
    else {
      cacheLog.notice(
        "RenderedPreviewCache: MISS \(assetURL.lastPathComponent, privacy: .public) — pipeline will run"
      )
      return nil
    }
    cacheLog.notice(
      "RenderedPreviewCache: DISK HIT \(assetURL.lastPathComponent, privacy: .public) (\(data.count) bytes) — SKIPPING Rust pipeline"
    )
    evictIfNeeded()
    memCache[key] = (ci, Date())
    return ci
  }

  // MARK: - Write

  /// A queued GPU exit write owns both its file revision and destination.
  /// Neither may be re-derived after readback while another folder is opening.
  struct WriteSnapshot: Sendable {
    fileprivate let assetURL: URL
    fileprivate let screenWidth: Int
    fileprivate let sidecarURL: URL?
    fileprivate let key: String
    fileprivate let directory: URL?
  }

  func captureWrite(for assetURL: URL, screenWidth: Int, sidecarURL: URL? = nil) -> WriteSnapshot? {
    let expected = assetURL.deletingLastPathComponent()
      .appendingPathComponent(".maple/previews", isDirectory: true).standardizedFileURL
    // An old session can start its exit task after the new folder configured
    // this shared actor. Do not place its derived file under that new folder.
    guard cacheDir?.standardizedFileURL.path == expected.path else { return nil }
    return writeSnapshot(for: assetURL, screenWidth: screenWidth, sidecarURL: sidecarURL)
  }

  private func writeSnapshot(for assetURL: URL, screenWidth: Int, sidecarURL: URL?) -> WriteSnapshot
  {
    WriteSnapshot(
      assetURL: assetURL, screenWidth: screenWidth, sidecarURL: sidecarURL,
      key: cacheKey(for: assetURL, screenWidth: screenWidth, sidecarURL: sidecarURL),
      directory: cacheDir)
  }

  public func storePreview(
    _ image: CIImage, for assetURL: URL, screenWidth: Int, sidecarURL: URL? = nil
  ) {
    storePreview(
      image, for: writeSnapshot(for: assetURL, screenWidth: screenWidth, sidecarURL: sidecarURL))
  }

  func storePreview(_ image: CIImage, for snapshot: WriteSnapshot) {
    guard
      snapshot.key
        == cacheKey(
          for: snapshot.assetURL, screenWidth: snapshot.screenWidth, sidecarURL: snapshot.sidecarURL
        )
    else { return }
    let key = snapshot.key
    evictIfNeeded()
    memCache[key] = (image, Date())

    guard let dir = snapshot.directory else { return }
    let fileURL = dir.appendingPathComponent("\(key).jpg")
    let ctx = CIContext()
    guard
      let data = ctx.jpegRepresentation(
        of: image,
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.90]
      )
    else { return }
    try? data.write(to: fileURL, options: .atomic)
  }

  // MARK: - Invalidate

  /// Remove all cached entries for an asset (call after sidecar write).
  /// Matches every screen-width variant by the `"{urlHash}_"` key prefix —
  /// see `cacheKey` for why the urlHash is a literal prefix.
  public func invalidate(assetURL: URL) {
    let prefix = "\(urlHash(assetURL.path))_"
    memCache = memCache.filter { !$0.key.hasPrefix(prefix) }
    guard let dir = cacheDir else { return }
    let files = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
    for f in files where f.hasPrefix(prefix) {
      try? fm.removeItem(at: dir.appendingPathComponent(f))
    }
  }

  // MARK: - Cache key

  // Key components: `(urlHash, primaryMtime, sidecarMtime, screenWidth)`.
  // `screenWidth` is the size bucket (per ticket 06 § Product Requirements 5).
  // Deliberately version-free (#4793).
  //
  // `primaryMtime` (#1928): the cached JPEG is rendered FROM the primary
  // RAW's pixels, so a change to those pixels that leaves the sidecar
  // untouched — re-import, external sync tool, filesystem restore — must
  // still miss. Keying only on `sidecarMtime` would serve a preview
  // developed from the old bytes under an identical key.
  // The key is `"{urlHash}_{sha256Prefix(variant)}"` — the per-asset `urlHash` is
  // kept as a literal prefix (not folded into the outer hash) so
  // `invalidate(assetURL:)` can find every screen-width variant of an asset
  // by prefix. Hashing the whole tuple into one opaque digest, as this did
  // before, left `invalidate` unable to match any on-disk filename (it was a
  // silent no-op — masked only because a sidecar/mtime change already bumps
  // the key on the next lookup).
  private func cacheKey(for url: URL, screenWidth: Int, sidecarURL: URL?) -> String {
    let primaryMtime = mtimeString(forPath: url.path)
    let primarySidecar = SidecarPath.sidecarURL(for: url).standardizedFileURL
    let selected = (sidecarURL ?? primarySidecar).standardizedFileURL
    let sidecarMtime = mtimeString(forPath: selected.path)
    // Keep primary entries warm; sibling paths remain distinct even at equal mtimes (#4063).
    let identity = selected == primarySidecar ? "" : "_" + sha256Prefix(selected.path)
    let variant = sha256Prefix(
      Self.variantToken(
        primaryMtime: primaryMtime,
        sidecarMtime: sidecarMtime,
        screenWidth: screenWidth) + identity)
    return "\(urlHash(url.path))_\(variant)"
  }

  /// The pre-hash variant token folded into the cache key. `internal` and
  /// `static` so the version-free key contract is unit-testable via `@testable`.
  static func variantToken(primaryMtime: String, sidecarMtime: String, screenWidth: Int) -> String {
    "\(primaryMtime)_\(sidecarMtime)_\(screenWidth)"
  }

  /// Millisecond mtime of the file at `path`, or `"0"` when it doesn't
  /// exist / is unreadable (a missing sidecar is the common `"0"` case).
  private func mtimeString(forPath path: String) -> String {
    guard let attrs = try? fm.attributesOfItem(atPath: path),
      let mtime = attrs[.modificationDate] as? Date
    else { return "0" }
    return String(Int64(mtime.timeIntervalSince1970 * 1000))
  }

  private func urlHash(_ path: String) -> String { sha256Prefix(path).prefix(16).description }

  // MARK: - Eviction

  private func evictIfNeeded() {
    while memCache.count >= maxMemEntries {
      // Evict oldest
      if let oldest = memCache.min(by: { $0.value.1 < $1.value.1 }) {
        memCache.removeValue(forKey: oldest.key)
      } else {
        break
      }
    }
  }

  // MARK: - Memory pressure

  /// Drop every in-memory entry (up to `maxMemEntries` full-viewport
  /// `CIImage`s) while leaving the on-disk `.maple/previews/` files
  /// untouched — a subsequent `preview(for:)` call still hits from disk,
  /// just pays a JPEG-decode instead of a dictionary lookup. Called by
  /// `MapleApp`'s memory-pressure observer (#2037): before this, only the
  /// (already-bounded) thumbnail cache responded to pressure while this
  /// cache's larger entries sat resident.
  public func handleMemoryPressure() {
    memCache.removeAll()
  }

  // MARK: - Test hooks

  /// Whether the in-memory front is empty. `internal` (test-visible via
  /// `@testable import`) — lets a test assert `handleMemoryPressure()`
  /// actually drained `memCache` without exposing the dictionary itself.
  internal func _testMemCacheIsEmpty() -> Bool { memCache.isEmpty }

  // MARK: - Hash (SHA256 prefix for key stability)

  /// The first 16 bytes of the string's SHA256, as 32 lowercase hex chars.
  /// (`urlHash` further truncates the result to 16 hex chars.)
  private func sha256Prefix(_ string: String) -> String {
    let digest = SHA256.hash(data: Data(string.utf8))
    return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
  }
}
