import Foundation
import MapleCore
import Observation

struct CloudFolderMoveNavigation: Equatable {
  let selection: LibrarySelection
  let path: String?
}

/// Single-flight server mutation with navigation guarded at completion (#4017).
/// The real RemoteCatalog supplies HTTP; the shell supplies current navigation.
@MainActor
@Observable
final class CloudFolderMoveVM {
  private(set) var isMoving = false

  @discardableResult
  func move(
    plan: CloudFolderMovePlan, server: URL, libraryID: String, catalog: RemoteCatalog,
    navigation: @escaping @MainActor () -> CloudFolderMoveNavigation,
    refresh: @escaping @MainActor () -> Void,
    reopen: @escaping @MainActor (String) -> Void,
    onFailure: @escaping @MainActor (Error) -> Void
  ) -> Bool {
    guard !isMoving, !plan.isNoOp else { return false }
    isMoving = true
    let initial = navigation()
    Task { @MainActor in
      defer { isMoving = false }
      do {
        let result = try await catalog.moveFolder(
          folderID: libraryID, sourceRelativePath: plan.sourceRelativePath,
          targetRelativePath: plan.targetRelativePath)
        switch result {
        case .ok:
          refresh()
          let current = navigation()
          guard current == initial,
            current.selection == .cloudLibrary(serverID: server, folderID: libraryID),
            let path = plan.reopenedPath(currentPath: current.path)
          else { return }
          reopen(path)
        case .conflict:
          guard navigation() == initial else { return }
          onFailure(FileOperationError.destinationExists(plan.targetPath))
        }
      } catch {
        guard navigation() == initial else { return }
        onFailure(error)
      }
    }
    return true
  }
}
