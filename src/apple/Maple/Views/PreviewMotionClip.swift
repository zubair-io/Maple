import Foundation
import MapleCore

/// Full image's lookup for the clip that belongs to a still: the one an
/// Android Motion Photo embeds in a JPEG or HEIC (#5447), or the partner
/// clip of an Apple Live Photo pair (#5448, #5544). Only a Self Hosted still
/// can carry a Motion Photo clip.
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

  /// Whether Full image offers a clip for `asset`. A Live Photo still is known to have one from its
  /// link, so nothing is fetched to find out; a Motion Photo is probed.
  static func hasClip(for asset: AssetRef, source: (any ImageSource)?) async -> Bool {
    if let link = asset.livePhoto { return link.role == .still }
    return await clipURL(for: asset, source: source) != nil
  }

  /// A Live Photo still names its partner in the folder listing, so the clip
  /// is resolved straight from it; a Motion Photo needs the server's HEAD
  /// probe to learn whether the still embeds a clip.
  static func clipURL(for asset: AssetRef, source: (any ImageSource)?) async -> URL? {
    if let link = asset.livePhoto {
      guard link.role == .still else { return nil }
      return await LivePhotoClip.playbackURL(for: asset, source: source)
    }
    guard let cloud = source as? CloudSource, let stableID = asset.stableID,
      canCarryClip(asset)
    else { return nil }
    return try? await cloud.motionClipURL(for: stableID)
  }
}
