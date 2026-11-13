// EditorCanvasSeed.swift — the image drawn as the editor canvas before the
// first real frame of a Maple Cloud asset (#5731, #5755, #5758).
//
// A Cloud asset's thumbnail lands in whichever cache its grid used: the
// Timeline and Search grids write `CloudThumbCache`, while folder browse and
// the filmstrip go through `ThumbnailLoader`, which keys the sourceless
// `ThumbnailDiskCache` by the asset's stable id. Until real pixels land the
// GPU canvas draws the seed as its placeholder, in the photo's frame and laid
// out at the seed's aspect, so a gesture on it survives the real size
// landing (#5755) and the first render changes only the pixels (#5758).

import CoreGraphics
import Foundation
import MapleCloudKit

public enum EditorCanvasSeed {
  /// Never calls the asset's `bytesProvider`: the editor is already
  /// downloading the original, and a seed must not fetch it a second time.
  /// `server` must serve `catalog.serverID` (see `server(_:serving:)`).
  public static func cloudThumbnailBytes(
    asset: AssetRef,
    catalog: CatalogRef,
    server: (any ImageSource)?,
    cloudThumbs: CloudThumbCache = CloudThumbCache(),
    thumbs: ThumbnailDiskCache = .shared
  ) async -> Data? {
    if let cached = await cloudThumbs.get(
      host: catalog.serverID.cacheHostKey, absPath: catalog.absPath)
    {
      return cached
    }
    let key = asset.stableID ?? asset.displayName
    if let cached = await thumbs.thumbnailData(forKey: key) {
      return cached
    }
    guard !Task.isCancelled, let server else { return nil }
    let ref = ImageRef(
      id: "fs:\(catalog.absPath)", displayName: asset.displayName, url: nil)
    guard let fetched = (try? await server.thumb(for: ref)) ?? nil else { return nil }
    await thumbs.storeThumbnailData(fetched, forKey: key)
    return fetched
  }

  /// The editor's ambient source belongs to whatever list was browsed, and a
  /// Timeline or Search list mixes servers; asking another server for this
  /// path could cache its file under this asset's key.
  public static func server(_ source: (any ImageSource)?, serving catalog: CatalogRef)
    -> CloudSource?
  {
    (source as? CloudSource).flatMap { $0.identity == catalog.serverID ? $0 : nil }
  }

  /// The canvas draws the seed at the photo's rect, so it is offered only
  /// until real pixels are on screen.
  public static func isVisible(showingOriginal: Bool, hasOnscreenFrame: Bool) -> Bool {
    !showingOriginal && !hasOnscreenFrame
  }

  /// No photo's pixel size is known before its original downloads, so the
  /// seed lays the canvas out at its own aspect and this long edge (#5755).
  /// Large enough that the 100% stop and a double-tap zoom in from fit on
  /// any screen, as they do on a real photo; the real size then replaces it
  /// with the on-screen rect kept.
  public static let provisionalLongEdge: CGFloat = 8192

  /// The stand-in extent for a seed image of `pixelSize`; `nil` for an
  /// empty image.
  public static func provisionalImageSize(forSeedOfPixelSize pixelSize: CGSize) -> CGSize? {
    guard pixelSize.width > 0, pixelSize.height > 0 else { return nil }
    let scale = provisionalLongEdge / max(pixelSize.width, pixelSize.height)
    return CGSize(width: pixelSize.width * scale, height: pixelSize.height * scale)
  }
}
