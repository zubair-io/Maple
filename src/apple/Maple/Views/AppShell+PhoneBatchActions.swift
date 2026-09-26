#if os(iOS)
  import Foundation
  import MapleCore

  struct PhoneAssetMoveRequest: Identifiable {
    let id = UUID()
    let assets: [AssetRef]
    let source: PhoneAssetMoveSource
  }

  @MainActor
  extension AppShell {
    var canOfferPhoneMove: Bool {
      switch librarySelection {
      case .folder:
        return activeScopeURL != nil && currentRootBookmark != nil
      case .cloudLibrary:
        return browseVM.currentSource is CloudSource
      default:
        return false
      }
    }

    private func phoneMoveSource() async -> PhoneAssetMoveSource? {
      switch librarySelection {
      case .folder:
        guard let root = activeScopeURL, let bookmark = currentRootBookmark else { return nil }
        return .local(rootURL: root, rootBookmark: bookmark)
      case .cloudLibrary(let serverID, let folderID):
        guard let source = browseVM.currentSource as? CloudSource,
          await source.folderID == folderID
        else { return nil }
        let root = await source.libraryPath
        guard browseVM.currentSource as? CloudSource === source else { return nil }
        return .cloud(server: serverID, libraryFolderID: folderID, libraryRootPath: root)
      default:
        return nil
      }
    }

    func beginPhoneBatchExport(_ assets: [AssetRef]) {
      guard !assets.isEmpty else { return }
      phoneBatchExportAssets = assets
      showsPhoneBatchExport = true
    }

    func beginPhoneAssetMove(_ ids: [AssetRef.ID]) {
      Task { @MainActor in
        guard let source = await phoneMoveSource() else {
          browseVM.loadError = FileOperationError.unsupportedSource(
            "This source cannot move photos.")
          return
        }
        let checked = Set(ids)
        let assets = browseVM.assets.filter { checked.contains($0.id) }
        guard assets.count == checked.count,
          PhoneAssetMoveEligibility.canMove(assets, from: source)
        else {
          browseVM.loadError = FileOperationError.unsupportedSource(
            "These photos cannot be moved from this source.")
          return
        }
        phoneMoveRequest = PhoneAssetMoveRequest(assets: assets, source: source)
      }
    }
  }
#endif
