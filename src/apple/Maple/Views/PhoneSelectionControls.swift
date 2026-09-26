#if os(iOS)
  import MapleCore
  import SwiftUI

  /// Keeps the phone's settings transfer sheet and durable progress alive when
  /// checked selection ends. The connected library is the same scoped writer
  /// used by desktop Browse; neither action writes to an unverified source.
  struct PhoneSelectionControls: View {
    let vm: BrowseViewModel
    let clipboard: AdjustmentClipboard?
    let onMergePanorama: (() -> Void)?
    let onEditMetadata: (() -> Void)?
    let onBatchRename: (() -> Void)?
    let onTrashAssets: (([AssetRef.ID]) -> Void)?
    let onExport: (([AssetRef]) -> Void)?
    let onMove: (([AssetRef.ID]) -> Void)?

    @Environment(\.batchAdjustmentLibrary) private var batchLibrary
    @State private var adjustmentDraft: AdjustmentTransferDraft?

    private var canPaste: Bool {
      guard let library = batchLibrary, let contents = clipboard?.contents,
        contents.scopeID == library.id
      else { return false }
      return !vm.selectedAssets.isEmpty
    }

    private var canSync: Bool {
      guard batchLibrary != nil, let source = vm.selectedAsset,
        source.adjustmentTransferTarget != nil
      else { return false }
      return vm.selectedAssets.contains { $0.id != source.id }
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 8) {
        if let controller = clipboard?.batchTransfers {
          BatchAdjustmentProgressView(controller: controller, library: batchLibrary)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
        if vm.isSelecting {
          PhoneSelectionBar(
            vm: vm,
            onMergePanorama: onMergePanorama,
            onEditMetadata: onEditMetadata,
            onBatchRename: onBatchRename,
            onTrashAssets: onTrashAssets,
            onExport: onExport,
            onMove: onMove,
            onPasteSettings: clipboard != nil ? pasteSettings : nil,
            onSyncSettings: clipboard != nil ? syncSettings : nil,
            canPasteSettings: canPaste,
            canSyncSettings: canSync
          )
        }
      }
      .padding(.leading, 12)
      .padding(.bottom, 12)
      .sheet(item: $adjustmentDraft) { draft in
        AdjustmentGroupPickerSheet(
          draft: draft,
          onApply: { request in
            adjustmentDraft = nil
            guard let controller = clipboard?.batchTransfers else { return }
            Task {
              await controller.start(
                request: request, targets: draft.targets, library: draft.library)
            }
          },
          onCancel: { adjustmentDraft = nil }
        )
      }
    }

    private func pasteSettings() {
      guard let source = clipboard?.contents else { return }
      presentTransfer(source: source, assets: vm.selectedAssets)
    }

    private func syncSettings() {
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
          try Task.checkCancellation()
          guard batchLibrary?.id == library.id else { return }
          presentTransfer(
            source: .init(
              model: model, sourceName: source.displayName,
              scopeID: library.id, sourceAsset: source),
            assets: targets)
        } catch {
          clipboard.batchTransfers.error = error.localizedDescription
        }
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
        adjustmentDraft = AdjustmentTransferDraft(
          source: source, targets: targets, library: library)
      } catch {
        clipboard.batchTransfers.error = error.localizedDescription
      }
    }
  }
#endif
