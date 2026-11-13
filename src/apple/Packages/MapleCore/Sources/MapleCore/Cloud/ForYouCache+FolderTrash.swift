import MapleCloudKit

extension ForYouCache {
  /// Apply the server's folder-trash outcome to the cached For You covers.
  public func forgetFolderTrash(
    _ summary: FolderTrashSummary, host: String, libraryFolderID: String, folderPath: String
  ) {
    if summary.failed > 0 {
      let failedIDs = Set(summary.items.filter { !$0.ok }.map(\.assetId))
      let assetIDs = Set(summary.items.filter(\.ok).map(\.assetId)).subtracting(failedIDs)
      forgetAssetsPreservingPages(
        host: host, libraryFolderID: libraryFolderID, folderPath: folderPath,
        assetIDs: assetIDs)
    } else {
      forgetFolder(host: host, libraryFolderID: libraryFolderID, folderPath: folderPath)
    }
  }
}
