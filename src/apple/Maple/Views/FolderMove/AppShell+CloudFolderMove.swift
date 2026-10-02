import MapleCore
import SwiftUI

@MainActor
extension AppShell {
  func beginCloudFolderMove(server: URL, libraryID: String, rootPath: String, path: String) {
    guard !cloudFolderMove.isMoving, sessionFor(server).hasFileAccess else { return }
    folderMove.begin(.cloud(server: server, libraryID: libraryID, rootPath: rootPath, path: path)) {
      let http = makeAuthenticatedHTTPClient(server: server)
      let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: server)
      let client = CloudFoldersClient(server: effectiveServer, httpClient: http)
      return try await CloudFolderMoveDestinations.tree(
        root: rootPath, rootName: rootPath == "/" ? "/" : (rootPath as NSString).lastPathComponent,
        excluding: path, client: client)
    } onFailure: { error in
      browseVM.loadError = error
    }
  }

  func moveCloudFolder(
    server: URL, libraryID: String, rootPath: String, path: String, into destination: String
  ) {
    guard !cloudFolderMove.isMoving, sessionFor(server).hasFileAccess else { return }
    let plan: CloudFolderMovePlan
    do {
      plan = try CloudFolderMovePlan(root: rootPath, source: path, destination: destination)
    } catch {
      browseVM.loadError = error
      return
    }
    cloudFolderMove.move(
      plan: plan, server: server, libraryID: libraryID, catalog: makeCloudCatalog(server: server),
      navigation: {
        CloudFolderMoveNavigation(selection: librarySelection, path: cloudCurrentPath)
      },
      refresh: { folderRefreshGeneration += 1 },
      reopen: { loadCloudLibrary(serverID: server, folderID: libraryID, libraryPath: $0) },
      onFailure: { browseVM.loadError = $0 })
  }
}
