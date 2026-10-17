import MapleCloudKit

extension ForYouCache {
  /// Apply the server's folder-trash outcome to the cached For You covers.
  public func forgetFolderTrash(
    _ summary: FolderTrashSummary, host: String, libraryFolderID: String, folderPath: String
  ) {
    if summary.failed > 0 {
      for item in summary.items where item.ok {
        forgetAsset(host: host, assetID: item.assetId)
      }
    } else {
      forgetFolder(host: host, libraryFolderID: libraryFolderID, folderPath: folderPath)
    }
  }
}
