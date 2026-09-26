#if os(iOS)
  import MapleCore
  import MapleUI
  import SwiftUI

  /// Actions for the phone Library's checked photos. The BrowseViewModel owns
  /// the selection so it survives a size-class change and a tab re-layout.
  struct PhoneSelectionBar: View {
    let vm: BrowseViewModel
    let onMergePanorama: (() -> Void)?
    let onEditMetadata: (() -> Void)?
    let onBatchRename: (() -> Void)?
    let onTrashAssets: (([AssetRef.ID]) -> Void)?
    /// The caller owns rendering, destination selection, and error reporting.
    /// Omitted until a real batch export route is connected.
    var onExport: (([AssetRef]) -> Void)? = nil
    /// The caller presents a destination picker, then uses AppShell's existing
    /// relocation flow (including collision and partial-failure sheets).
    var onMove: (([AssetRef.ID]) -> Void)? = nil
    var onPasteSettings: (() -> Void)? = nil
    var onSyncSettings: (() -> Void)? = nil
    var canPasteSettings = false
    var canSyncSettings = false
    @State private var showingTrashConfirmation = false
    @State private var pendingTrashIDs: [AssetRef.ID] = []

    private var selectedAssets: [AssetRef] { vm.selectedAssets }

    private var hasSelection: Bool { !selectedAssets.isEmpty }

    /// Batch metadata's current writer only writes local XMP sidecars.
    private var canEditMetadata: Bool {
      hasSelection && selectedAssets.allSatisfy { $0.primaryURL != nil }
    }

    private var canRenameOrMove: Bool {
      guard hasSelection,
        !(vm.currentSource is PhotoKitSource),
        !selectedAssets.contains(where: { $0.thumbnailProvenance == .photoKit })
      else { return false }
      return selectedAssets.allSatisfy { $0.primaryURL != nil }
        || selectedAssets.allSatisfy { $0.catalog != nil }
        || (vm.currentSource is SMBSource
          && selectedAssets.allSatisfy {
            $0.primaryURL == nil && $0.catalog == nil && $0.thumbnailProvenance == .smb
          })
    }

    private var canExport: Bool {
      hasSelection && selectedAssets.allSatisfy { !$0.isVideo && !$0.isAudio && !$0.isStub }
    }

    private var canTransferSettings: Bool {
      hasSelection && selectedAssets.allSatisfy { $0.adjustmentTransferTarget != nil }
    }

    private var hasSyncSourceAndTarget: Bool {
      guard let sourceID = vm.selectedID,
        vm.selectedAsset?.adjustmentTransferTarget != nil
      else { return false }
      return vm.selectedIDs.contains { $0 != sourceID }
    }

    private var allSelected: Bool {
      !vm.assets.isEmpty && vm.assets.allSatisfy { vm.selectedIDs.contains($0.id) }
    }

    private var selectAllState: MuiCheckboxState {
      if allSelected { return .checked }
      return vm.selectedIDs.isEmpty ? .unchecked : .indeterminate
    }

    private var canTrash: Bool {
      canRenameOrMove
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          MuiCheckbox(
            state: selectAllState,
            label: allSelected ? "Deselect All" : "Select All",
            disabled: vm.assets.isEmpty
          ) {
            if allSelected {
              vm.clearSelection()
            } else {
              vm.selectedIDs = Set(vm.assets.map(\.id))
            }
          }
          .padding(.horizontal, 12)
          .background(.ultraThinMaterial, in: Capsule())
          .accessibilityLabel(allSelected ? "Deselect all photos" : "Select all photos")
          .accessibilityIdentifier("phone-select-all")

          Text("\(vm.selectedIDs.count) selected")
            .font(.subheadline)
            .frame(minHeight: 44)
            .padding(.horizontal, 12)
            .background(.ultraThinMaterial, in: Capsule())
            .accessibilityIdentifier("phone-selection-count")

          Button("Clear") { vm.clearSelection() }
            .disabled(!hasSelection)
            .frame(minHeight: 44)
            .padding(.horizontal, 12)
            .background(.ultraThinMaterial, in: Capsule())
            .accessibilityIdentifier("phone-selection-clear")
        }

        HStack(spacing: 8) {
          if let onExport {
            Button("Export…", systemImage: "square.and.arrow.up") {
              onExport(selectedAssets)
            }
            .disabled(!canExport)
            .frame(minHeight: 44)
            .padding(.horizontal, 12)
            .background(.ultraThinMaterial, in: Capsule())
            .accessibilityIdentifier("phone-selection-export")
          }

          if let onMove {
            Button("Move to…", systemImage: "folder") {
              onMove(selectedAssets.map(\.id))
            }
            .disabled(!canRenameOrMove)
            .frame(minHeight: 44)
            .padding(.horizontal, 12)
            .background(.ultraThinMaterial, in: Capsule())
            .accessibilityIdentifier("phone-selection-move")
          }

          Menu {
            if let onEditMetadata {
              Button(
                "Edit Metadata…", systemImage: "pencil.and.list.clipboard", action: onEditMetadata
              )
              .disabled(!canEditMetadata)
            }
            if let onBatchRename {
              Button("Batch Rename…", systemImage: "textformat", action: onBatchRename)
                .disabled(!canRenameOrMove)
            }
            if let onSyncSettings {
              Button(
                "Sync Settings…", systemImage: "arrow.triangle.2.circlepath", action: onSyncSettings
              )
              .disabled(!canTransferSettings || !hasSyncSourceAndTarget || !canSyncSettings)
            }
            if let onPasteSettings {
              Button("Paste Settings…", systemImage: "doc.on.clipboard", action: onPasteSettings)
                .disabled(!canTransferSettings || !canPasteSettings)
            }
            if FeatureFlags.isPanoramaEnabled, let onMergePanorama {
              Button("Merge to Panorama…", systemImage: "photo.stack", action: onMergePanorama)
                .disabled(!vm.canMergePanorama || !canExport)
            }
            if onTrashAssets != nil {
              Button("Move to Trash", systemImage: "trash", role: .destructive) {
                pendingTrashIDs = selectedAssets.map(\.id)
                showingTrashConfirmation = true
              }
              .disabled(!canTrash)
            }
          } label: {
            Label("More", systemImage: "ellipsis.circle")
              .frame(minHeight: 44)
              .padding(.horizontal, 12)
          }
          .background(.ultraThinMaterial, in: Capsule())
          .disabled(!hasSelection)
          .accessibilityIdentifier("phone-selection-more")
        }
      }
      .buttonStyle(.borderless)
      .confirmationDialog(
        "Move \(pendingTrashIDs.count) selected photos to Trash?",
        isPresented: $showingTrashConfirmation,
        titleVisibility: .visible
      ) {
        Button("Move to Trash", role: .destructive) {
          onTrashAssets?(pendingTrashIDs)
          pendingTrashIDs = []
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("phone-selection-bar")
    }
  }
#endif
