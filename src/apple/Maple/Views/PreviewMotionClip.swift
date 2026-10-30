import Foundation
import MapleCore

/// Full image's lookup for the clip that belongs to a still: the one an
/// Android Motion Photo embeds in a JPEG or HEIC (#5447), or the partner
/// clip of an Apple Live Photo pair (#5448). Only server-backed stills can
/// carry one here.
enum PreviewMotionClip {
  static let stillExtensions: Set<String> = ["jpg", "jpeg", "heic", "heif"]

  static func canCarryClip(_ asset: AssetRef) -> Bool {
    guard !asset.isVideo else { return false }
    let ext = (asset.hintExtension ?? (asset.displayName as NSString).pathExtension).lowercased()
    return stillExtensions.contains(ext)
  }

  static func playLabel(for asset: AssetRef) -> String {
    asset.livePhoto?.role == .still ? "Play Live Photo" : "Play Motion Photo"
  }

  /// A Live Photo still names its partner in the folder listing, so the clip
  /// URL is minted straight from it; a Motion Photo needs the server's HEAD
  /// probe to learn whether the still embeds a clip.
  static func clipURL(for asset: AssetRef, source: (any ImageSource)?) async -> URL? {
    guard let cloud = source as? CloudSource, let stableID = asset.stableID else { return nil }
    if let link = asset.livePhoto {
      guard link.role == .still else { return nil }
      return try? await cloud.videoURL(for: link.partnerRefID(ofRefID: stableID))
    }
    guard canCarryClip(asset) else { return nil }
    return try? await cloud.motionClipURL(for: stableID)
  }
}
