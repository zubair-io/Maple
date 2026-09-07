// FolderMoveSheets.swift — the "Move Folder to…" destination picker (#2847),
// as ONE reusable `View` extension attached to both of `AppShell`'s modifier
// chains (Mac/iPad pane shell + iPhone tab shell), same reasoning as
// `AssetDropSheets.swift`: one place for the present/confirm/dismiss logic
// so the two shells can't drift.
//
// Two phases, driven by `FolderMoveVM` (`FolderMove+VM.swift`): while the
// destination tree is being built, a small Overlay Shell with a Spinner
// ("Finding folders…") and a Cancel — up the instant the user asks, so a
// long SMB walk never looks like a dropped click (PR #3429 review); once
// the tree is ready, Maple UI's Move To Modal (`MuiMoveToModal`, catalog
// §4.4). Both are hosted as a window-level `.overlay` because Overlay Shell
// paints its own scrim rather than living inside a system sheet.

import SwiftUI
import MapleCore
import MapleUI

/// What the picker is moving, plus the destination tree it offers. Built
/// by `FolderMoveVM.begin` from `AppShell.beginLocalFolderMove` /
/// `beginSMBFolderMove`; consumed by `AppShell.confirmFolderMove`.
struct FolderMovePrompt: Identifiable {
    enum Target {
        case local(folderURL: URL, rootBookmark: Data)
        case smb(share: SMBCredentialStore.SavedShare, path: String)
    }

    let id = UUID()
    let target: Target
    let nodes: [FolderMoveDestination]
}

extension View {
    /// Attaches the "Move Folder to…" picker and its loading sheet.
    /// `onConfirm` receives the prompt and the chosen destination's id —
    /// the absolute path (local) or share-relative path (SMB) the engine's
    /// `moveFolder(_:into:)` takes as the new parent.
    func folderMoveOverlay(
        vm: FolderMoveVM,
        onConfirm: @escaping (FolderMovePrompt, String) -> Void
    ) -> some View {
        overlay {
            // Keyed on the prompt's identity so every presentation starts
            // with a fresh selection and collapsed tree — the modal keeps
            // its expansion set as private state.
            FolderMoveModalHost(vm: vm, onConfirm: onConfirm)
                .id(vm.prompt?.id)
        }
    }
}

private struct FolderMoveModalHost: View {
    let vm: FolderMoveVM
    let onConfirm: (FolderMovePrompt, String) -> Void

    @State private var selectedID: String?

    var body: some View {
        ZStack {
            FolderMovePreparingSheet(isPresented: vm.isPreparing) { vm.cancel() }
            MuiMoveToModal(
                isPresented: vm.prompt != nil,
                nodes: (vm.prompt?.nodes ?? []).map { node in
                    MuiMoveToTreeNode(
                        id: node.id, parentId: node.parentID, name: node.name,
                        depth: node.depth, hasChildren: node.hasChildren)
                },
                selectedId: $selectedID,
                moveConfirmed: { destination in
                    guard let confirmed = vm.finish() else { return }
                    onConfirm(confirmed, destination)
                },
                dismissed: { vm.cancel() }
            )
        }
    }
}

/// The loading state: same Overlay Shell chrome the picker will replace it
/// with, a Spinner (spinner.md — inline next to its label), and a Cancel
/// that stops the walk. Dismissing via the scrim cancels too.
private struct FolderMovePreparingSheet: View {
    let isPresented: Bool
    let cancel: () -> Void

    var body: some View {
        MuiOverlayShell(isPresented: isPresented, size: .sm, accessibilityLabel: "Move To") {
            MuiText("Move To", variant: .sheetTitle)
        } content: {
            HStack(spacing: MuiTokens.spacingSm) {
                MuiSpinner(size: .md, label: "Finding folders")
                MuiText("Finding folders…", color: .muted)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("folder-move-preparing")
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { cancel() }
            }
        } dismissed: {
            cancel()
        }
    }
}
