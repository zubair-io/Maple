import Foundation

/// Where a Live Photo's clip plays from, whichever source listed the pair: the Self Hosted
/// server mints a short-lived video URL, a local folder plays the file in place, and an SMB share
/// stages a copy for AVPlayer.
public enum LivePhotoClip {
  /// A playable URL for the clip half of `asset`'s Live Photo pair: `asset` itself when it is the
  /// clip, its partner when it is the still. Nil when `asset` is not paired or the clip cannot be reached.
  public static func playbackURL(for asset: AssetRef, source: (any ImageSource)?) async -> URL? {
    guard let link = asset.livePhoto else { return nil }
    if let cloud = source as? CloudSource, let stableID = asset.stableID {
      let clipID = link.role == .clip ? stableID : link.partnerRefID(ofRefID: stableID)
      return try? await cloud.videoURL(for: clipID)
    }
    if let url = asset.primaryURL {
      return link.role == .clip
        ? url : url.deletingLastPathComponent().appendingPathComponent(link.partner)
    }
    if let smb = source as? SMBSource, let path = asset.smbPath {
      let clipPath =
        link.role == .clip
        ? path
        : ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent(
          link.partner)
      return try? await smb.liveClipFile(atPath: clipPath, listedBy: asset.smbSourceID)
    }
    return nil
  }
}
