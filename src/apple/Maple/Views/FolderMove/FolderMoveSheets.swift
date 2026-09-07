// FolderMoveSheets.swift — the "Move Folder to…" destination picker (#2847),
// as ONE reusable `View` extension attached to both of `AppShell`'s modifier
// chains (Mac/iPad pane shell + iPhone tab shell), same reasoning as
// `AssetDropSheets.swift`: one place for the present/confirm/dismiss logic
// so the two shells can't drift.
//
// The picker itself is Maple UI's Move To Modal (`MuiMoveToModal`, catalog
// §4.4) — the same destination-tree organism the web reference uses for
// asset moves — hosted as a window-level `.overlay` because Overlay Shell
// paints its own scrim rather than living inside a system sheet.

import SwiftUI
import MapleCore
import MapleUI

/// What the picker is moving, plus the destination tree it offers. Built
/// by `AppShell.beginLocalFolderMove` / `beginSMBFolderMove`; consumed by
/// `AppShell.confirmFolderMove`.
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
    /// Attaches the "Move Folder to…" picker. `onConfirm` receives the
    /// prompt and the chosen destination's id — the absolute path (local)
    /// or share-relative path (SMB) the engine's `moveFolder(_:into:)`
    /// takes as the new parent.
    func folderMoveOverlay(
        prompt: Binding<FolderMovePrompt?>,
        onConfirm: @escaping (FolderMovePrompt, String) -> Void
    ) -> some View {
        overlay {
            // Keyed on the prompt's identity so every presentation starts
            // with a fresh selection and collapsed tree — the modal keeps
            // its expansion set as private state.
            FolderMoveModalHost(prompt: prompt, onConfirm: onConfirm)
                .id(prompt.wrappedValue?.id)
        }
    }
}

private struct FolderMoveModalHost: View {
    @Binding var prompt: FolderMovePrompt?
    let onConfirm: (FolderMovePrompt, String) -> Void

    @State private var selectedID: String?

    var body: some View {
        MuiMoveToModal(
            isPresented: prompt != nil,
            nodes: (prompt?.nodes ?? []).map { node in
                MuiMoveToTreeNode(
                    id: node.id, parentId: node.parentID, name: node.name,
                    depth: node.depth, hasChildren: node.hasChildren)
            },
            selectedId: $selectedID,
            moveConfirmed: { destination in
                guard let confirmed = prompt else { return }
                prompt = nil
                onConfirm(confirmed, destination)
            },
            dismissed: { prompt = nil }
        )
    }
}
