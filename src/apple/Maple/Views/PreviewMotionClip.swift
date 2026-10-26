import Foundation
import MapleCore

/// Full image's lookup for the clip an Android Motion Photo embeds in a
/// JPEG or HEIC still (#5447). Only server-backed stills can carry one here:
/// the server's `motion-photo` stage is what finds and verifies the clip.
enum PreviewMotionClip {
  static let stillExtensions: Set<String> = ["jpg", "jpeg", "heic", "heif"]

  static func canCarryClip(_ asset: AssetRef) -> Bool {
    guard !asset.isVideo else { return false }
    let ext = (asset.hintExtension ?? (asset.displayName as NSString).pathExtension).lowercased()
    return stillExtensions.contains(ext)
  }

  static func clipURL(for asset: AssetRef, source: (any ImageSource)?) async -> URL? {
    guard canCarryClip(asset), let cloud = source as? CloudSource, let stableID = asset.stableID
    else { return nil }
    return try? await cloud.motionClipURL(for: stableID)
  }
}
