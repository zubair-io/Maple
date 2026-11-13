// MapleSidecarPaths.swift — asset-relative locations of the canonical
// `.maple/{thumbs,previews}/` derivative cache, computed from an asset's own
// directory (not a singleton's configured folder). This is what lets an
// injected pano — which lives in a `Panoramas/` subfolder while the cache
// singletons are configured for the open folder — resolve its render-time
// derivatives. Mirrors the Rust writer in
// `maple-pano/src/stitch/sidecars.rs::SidecarDownscaler` (#1365).

import Foundation

public enum MapleSidecarPaths {
  /// Name of the per-folder derivative directory every cache below lives
  /// in. Internal library state, never user content: enumeration sites
  /// (`FolderTreeRow`, `SMBFileOperations.listSubdirectories`,
  /// `DropMountPlanner`) must exclude it rather than surface it as an
  /// ordinary browsable folder.
  public static let derivativeDirectoryName = ".maple"

  /// Whether `url` IS a `.maple` derivative directory, or lives anywhere
  /// inside one (`<lib>/.maple/trash/IMG.dng` → `true`). Component-wise
  /// match, so a user folder that merely CONTAINS the text — `.maplestuff`
  /// — is not mistaken for it.
  public static func isInsideDerivativeDirectory(_ url: URL) -> Bool {
    url.standardizedFileURL.pathComponents.contains(derivativeDirectoryName)
  }

  /// `<assetDir>/.maple/thumbs/<filename.ext>.avif` (#4793).
  public static func thumbURL(for assetURL: URL) -> URL {
    // Append each component separately (matches ThumbnailDiskCache.configure
    // / RenderedPreviewCache.configure) — avoids slash-in-component edge cases.
    return assetURL.deletingLastPathComponent()
      .appendingPathComponent(derivativeDirectoryName)
      .appendingPathComponent("thumbs")
      .appendingPathComponent(
        MapleThumbCacheKey.thumbFilename(forRawBasename: assetURL.lastPathComponent))
  }

  /// `<assetDir>/.maple/previews/<filename.ext>.avif`. Unversioned (#4793):
  /// a pipeline bump never invalidates a shared derivative.
  public static func previewURL(for assetURL: URL) -> URL {
    // Append each component separately — avoids slash-in-component edge
    // cases (matches `thumbURL`).
    return assetURL.deletingLastPathComponent()
      .appendingPathComponent(derivativeDirectoryName)
      .appendingPathComponent("previews")
      .appendingPathComponent(previewFilename(forRawBasename: assetURL.lastPathComponent))
  }

  public static func previewFilename(forRawBasename basename: String) -> String {
    "\(basename).avif"
  }

  // MARK: - Legacy `.v25` adoption (#4793)

  // Builds between b197b1b5db and #4796 wrote `<sha16>.v25.avif` thumbs and
  // `<filename.ext>.v25.avif` previews. The server's sweep renames those in
  // folders it indexes; local, SMB and Files folders it never sees are
  // migrated by readers, one frozen name, on a miss only.
  static let legacyDerivativeSuffix = ".v25.avif"

  public static func legacyPreviewFilename(forRawBasename basename: String) -> String {
    "\(basename)\(legacyDerivativeSuffix)"
  }

  /// `<assetDir>/.maple/thumbs/<sha256prefix16(basename)>.v25.avif`
  public static func legacyThumbURL(for assetURL: URL) -> URL {
    thumbURL(for: assetURL).deletingLastPathComponent()
      .appendingPathComponent(
        MapleThumbCacheKey.legacyThumbFilename(forRawBasename: assetURL.lastPathComponent))
  }

  /// `<assetDir>/.maple/previews/<filename.ext>.v25.avif`
  public static func legacyPreviewURL(for assetURL: URL) -> URL {
    previewURL(for: assetURL).deletingLastPathComponent()
      .appendingPathComponent(legacyPreviewFilename(forRawBasename: assetURL.lastPathComponent))
  }

  /// Renames `legacy` onto `derivativeURL`. The rename attempt doubles as
  /// the existence check, so a miss with no legacy file costs exactly one
  /// extra filesystem operation.
  @discardableResult
  public static func adoptLegacyDerivative(
    at derivativeURL: URL, legacy: URL, fileManager fm: FileManager = .default
  ) -> Bool {
    (try? fm.moveItem(at: legacy, to: derivativeURL)) != nil
  }

  /// Bytes of the derivative at `derivativeURL`. A hit is one read; a miss
  /// adopts `legacy` (if present) and reads once more.
  public static func readDerivative(
    at derivativeURL: URL, legacy: URL, fileManager fm: FileManager = .default
  ) -> Data? {
    if let data = try? Data(contentsOf: derivativeURL) { return data }
    guard adoptLegacyDerivative(at: derivativeURL, legacy: legacy, fileManager: fm) else {
      return nil
    }
    return try? Data(contentsOf: derivativeURL)
  }
}
