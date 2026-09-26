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
    @State private var showingTrashConfirmation = false

    private var allSelected: Bool {
      !vm.assets.isEmpty && vm.assets.allSatisfy { vm.selectedIDs.contains($0.id) }
    }

    private var selectAllState: MuiCheckboxState {
      if allSelected { return .checked }
      return vm.selectedIDs.isEmpty ? .unchecked : .indeterminate
    }

    private var canTrash: Bool {
      !vm.selectedIDs.isEmpty
        && vm.selectedAssets.allSatisfy { $0.thumbnailProvenance != .photoKit }
        && !(vm.currentSource is PhotoKitSource)
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
        }

        HStack(spacing: 8) {
          Menu {
            if let onEditMetadata {
              Button(
                "Edit Metadata…", systemImage: "pencil.and.list.clipboard", action: onEditMetadata
              )
              .disabled(vm.selectedIDs.isEmpty)
            }
            if let onBatchRename {
              Button("Batch Rename…", systemImage: "textformat", action: onBatchRename)
                .disabled(vm.selectedIDs.isEmpty)
            }
            if FeatureFlags.isPanoramaEnabled, let onMergePanorama {
              Button("Merge to Panorama…", systemImage: "photo.stack", action: onMergePanorama)
                .disabled(!vm.canMergePanorama)
            }
            if onTrashAssets != nil {
              Button("Move to Trash", systemImage: "trash", role: .destructive) {
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
          .disabled(vm.selectedIDs.isEmpty)
          .accessibilityIdentifier("phone-selection-more")

          Button("Clear") { vm.clearSelection() }
            .disabled(vm.selectedIDs.isEmpty)
            .frame(minHeight: 44)
            .padding(.horizontal, 16)
            .background(.ultraThinMaterial, in: Capsule())
            .accessibilityIdentifier("phone-selection-clear")
        }
      }
      .buttonStyle(.borderless)
      .confirmationDialog(
        "Move \(vm.selectedIDs.count) selected photos to Trash?",
        isPresented: $showingTrashConfirmation,
        titleVisibility: .visible
      ) {
        Button("Move to Trash", role: .destructive) {
          onTrashAssets?(vm.selectedAssets.map(\.id))
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("phone-selection-bar")
    }
  }
#endif
