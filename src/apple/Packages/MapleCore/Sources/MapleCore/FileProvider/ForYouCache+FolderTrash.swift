import MapleCloudKit

extension ForYouCache {
  /// Apply the server's folder-trash outcome to the cached For You covers.
  public func forgetFolderTrash(
    _ summary: FolderTrashSummary, host: String, libraryFolderID: String, folderPath: String
  ) {
    if summary.failed > 0 {
      let assetIDs = Set(summary.items.filter(\.ok).map(\.assetId))
      forgetAssetsPreservingPages(host: host, assetIDs: assetIDs)
    } else {
      forgetFolder(host: host, libraryFolderID: libraryFolderID, folderPath: folderPath)
    }
  }
}
