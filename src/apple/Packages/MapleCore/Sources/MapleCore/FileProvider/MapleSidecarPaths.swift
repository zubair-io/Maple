// MapleSidecarPaths.swift — asset-relative locations of the canonical
// `.maple/{thumbs,previews}/` derivative cache, computed from an asset's own
// directory (not a singleton's configured folder). This is what lets an
// injected pano — which lives in a `Panoramas/` subfolder while the cache
// singletons are configured for the open folder — resolve its render-time
// derivatives. Mirrors the Rust writer in
// `maple-pano/src/stitch/io.rs::write_display_sidecars` (#1365).

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

  /// `<assetDir>/.maple/thumbs/<sha256prefix16(basename)>.v<N>.avif`
  public static func thumbURL(for assetURL: URL) -> URL {
    // Append each component separately (matches ThumbnailDiskCache.configure
    // / RenderedPreviewCache.configure) — avoids slash-in-component edge cases.
    return assetURL.deletingLastPathComponent()
      .appendingPathComponent(derivativeDirectoryName)
      .appendingPathComponent("thumbs")
      .appendingPathComponent(
        MapleThumbCacheKey.thumbFilename(forRawBasename: assetURL.lastPathComponent))
  }

  /// The current pipeline's shared display preview, including the original extension.
  public static func previewURL(for assetURL: URL) -> URL {
    // Append each component separately — avoids slash-in-component edge
    // cases (matches `thumbURL`).
    return assetURL.deletingLastPathComponent()
      .appendingPathComponent(derivativeDirectoryName)
      .appendingPathComponent("previews")
      .appendingPathComponent(previewFilename(forRawBasename: assetURL.lastPathComponent))
  }

  public static func previewFilename(forRawBasename basename: String) -> String {
    "\(basename).v\(AdjustmentModel.pipelineOutputVersion).avif"
  }
}
