// EditorCanvasSeed.swift — the image painted over the editor canvas before
// the first real frame of a Maple Cloud asset (#5731).
//
// A Cloud asset's thumbnail lands in whichever cache its grid used: the
// Timeline and Search grids write `CloudThumbCache`, while folder browse and
// the filmstrip go through `ThumbnailLoader`, which keys the sourceless
// `ThumbnailDiskCache` by the asset's stable id.

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

  /// A bytes-backed asset learns its pixel size only from the downloaded
  /// original, so until then the zoom host has no frame to draw even a
  /// published preview into; the seed stays up through that window.
  public static func isVisible(
    showingOriginal: Bool, hasOnscreenFrame: Bool, hasDisplayFrame: Bool
  ) -> Bool {
    !showingOriginal && !(hasOnscreenFrame && hasDisplayFrame)
  }
}
