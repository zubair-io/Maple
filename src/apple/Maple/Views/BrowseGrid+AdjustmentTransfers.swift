import MapleCore
import SwiftUI

extension BrowseGrid {
  var canSyncSettings: Bool {
    guard let sourceID = vm.selectedID else { return false }
    return vm.selectedIDs.contains { $0 != sourceID }
  }

  func copyAdjustments() {
    guard let clipboard, let asset = vm.selectedAsset else { return }
    guard let library = batchLibrary else {
      clipboard.batchTransfers.error = "Open a single library or folder to copy settings."
      return
    }
    let requestID = clipboard.beginCopyRequest()
    Task {
      do {
        _ = try library.store(asset)
        let model = try await library.readModel(for: asset)
        clipboard.copy(
          model: model, sourceName: asset.displayName, scopeID: library.id, sourceAsset: asset,
          requestID: requestID)
      } catch { clipboard.batchTransfers.error = error.localizedDescription }
    }
  }

  func pasteAdjustments() {
    guard let source = clipboard?.contents else { return }
    let targets = vm.isSelecting ? vm.selectedAssets : (vm.selectedAsset.map { [$0] } ?? [])
    presentTransfer(source: source, assets: targets)
  }

  func syncSettings() {
    guard let clipboard, let source = vm.selectedAsset else { return }
    guard let library = batchLibrary else {
      clipboard.batchTransfers.error = "Open a single library or folder to sync settings."
      return
    }
    let targets = vm.selectedAssets.filter { $0.id != source.id }
    Task {
      do {
        _ = try library.store(source)
        let model = try await library.readModel(for: source)
        presentTransfer(
          source: .init(
            model: model, sourceName: source.displayName,
            scopeID: library.id, sourceAsset: source), assets: targets)
      } catch { clipboard.batchTransfers.error = error.localizedDescription }
    }
  }

  private func presentTransfer(source: AdjustmentClipboard.Contents, assets: [AssetRef]) {
    guard let clipboard else { return }
    do {
      guard let library = batchLibrary, source.scopeID == library.id else {
        throw BatchAdjustmentError.wrongLibrary
      }
      let targets = try assets.map { asset in
        _ = try library.store(asset)
        guard let target = asset.adjustmentTransferTarget else {
          throw BatchAdjustmentError.invalidOperation
        }
        return target
      }
      guard !targets.isEmpty else { return }
      adjustmentDraft = AdjustmentTransferDraft(source: source, targets: targets, library: library)
    } catch { clipboard.batchTransfers.error = error.localizedDescription }
  }
}
