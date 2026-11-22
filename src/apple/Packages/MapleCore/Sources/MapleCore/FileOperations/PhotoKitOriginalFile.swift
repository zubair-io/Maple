import Foundation
import Photos

/// The Photos Library original behind a PhotoKit tile: the same `.photo` / `.video`
/// resource the backup engine uploads, written as a file for drag-out and Copy (#6002).
public enum PhotoKitOriginalFile {
  /// The original's own filename (`IMG_0001.HEIC`), or nil when the asset is gone.
  public static func fileName(localID: String) -> String? {
    originalResource(localID: localID)?.originalFilename
  }

  /// iCloud-only originals download on demand, as the editor's byte fetch already does.
  public static func write(localID: String, to destination: URL) async throws {
    guard let resource = originalResource(localID: localID) else {
      throw ImageSourceError.notFound(localID)
    }
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = true
    try await PHAssetResourceManager.default().writeData(
      for: resource, toFile: destination, options: options)
  }

  private static func originalResource(localID: String) -> PHAssetResource? {
    guard
      let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localID], options: nil).firstObject
    else { return nil }
    return PHAssetResource.assetResources(for: asset).first {
      $0.type == .photo || $0.type == .video
    }
  }
}
