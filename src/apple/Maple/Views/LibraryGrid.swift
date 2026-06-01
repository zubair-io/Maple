// LibraryGrid.swift — responsive-program S2 (#623). Responsive photo
// grid for the Library tab.
//
// Drives column count, gap, and outer padding off the
// `@Environment(\.mapleLayout)` density signal published by AppShell:
//
//   * phone   — 3 fixed columns, 2pt gaps, 2pt horizontal padding
//               (edge-bleed: no vertical padding).
//   * tablet  — 5 fixed columns, 4pt gaps, 8pt outer padding.
//   * desktop — adaptive tracks at `minmax(180pt, 1fr)`, 4pt gaps,
//               12pt outer padding. Mirrors the web spec's CSS
//               `repeat(auto-fill, minmax(180px, 1fr))` rule.
//
// Cell tap routes through `onOpenEditor` (same callback BrowseGrid
// uses — the iPhone shell already pushes the Editor via
// `.navigationDestination(for: AssetRef.self)`).
//
// The in-content source title and the cull filter-chip row were removed
// (#782): the source name lives in the nav bar, and the chips duplicated
// cull state that belongs in the editor. The grid now renders
// `vm.assets` unfiltered.
//
// Spec: docs/design/responsive-program/s2-library-grid.md.

#if os(iOS)

import SwiftUI
import MapleCore
#if canImport(UIKit)
import UIKit
#endif

struct LibraryGrid: View {
    @Environment(\.mapleLayout) private var layout

    let vm: BrowseViewModel
    let source: (any ImageSource)?
    @Binding var sessions: [AssetRef.ID: EditSession]
    @Binding var displayMode: GridDisplayMode

    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    /// Tap on a sub-folder tile — drills the grid into that folder.
    /// Forwarded straight to `AppShell.navigateFolder`, which is already
    /// cloud-aware (drills via `/api/fs/dir`) and handles local folders
    /// via the active security-scope bookmark.
    let onNavigateFolder: (URL) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // The in-content source title and the cull filter-chip row
                // (All / Picks / 4+ stars / Edited) were removed (#782):
                // the source name already lives in the nav bar, and the
                // chips duplicated cull state that belongs in the editor.
                LazyVGrid(columns: columns, spacing: gridGap) {
                    // Sub-folders first (Finder-style), then images — matches
                    // the desktop BrowseGrid. `vm.subfolders` is populated by
                    // loadFolder / loadCloudDir; without this the iPhone grid
                    // dropped folders entirely (they loaded but were never
                    // drawn). Order is reversed per request (#782) so the
                    // first-level folders read newest/last-first.
                    ForEach(Array(vm.subfolders.reversed()), id: \.self) { url in
                        LibraryFolderCell(url: url) { onNavigateFolder(url) }
                    }
                    ForEach(vm.assets) { asset in
                        LibraryCell(
                            asset: asset,
                            isSelected: vm.selectedID == asset.id,
                            session: sessions[asset.id],
                            source: source,
                            displayMode: displayMode,
                            style: .phone
                        )
                        .id(asset.id)
                        .contentShape(Rectangle())
                        .onAppear { onPrimeSession(asset) }
                        .onTapGesture {
                            vm.selectedID = asset.id
                            // Selection haptic — matches the spec §2 phone
                            // interaction model (`.selection` on iOS).
                            #if canImport(UIKit)
                            UISelectionFeedbackGenerator().selectionChanged()
                            #endif
                            // Pushes the S5 Editor onto the phone Library
                            // tab's NavigationStack (#791). `PhoneTabShell`
                            // injects an `onOpenEditor` that appends `asset`
                            // to its `libraryPath`; `PhoneLibraryView`'s
                            // `.navigationDestination(for: AssetRef.self)`
                            // then resolves it into `EditorDestination →
                            // EditorView` and `.toolbar(.hidden, for:
                            // .tabBar)` hides the tab bar on push (spec §2).
                            // The Mac/iPad pane shell injects a different
                            // `onOpenEditor` (AppShell's `.browse →
                            // .fullImage` mode flip) — this shared cell stays
                            // agnostic to which one it got.
                            onOpenEditor(asset)
                        }
                    }
                }
                .padding(.horizontal, outerHorizontalPadding)
                .accessibilityIdentifier("library-grid")
            }
        }
        .background(MapleTokens.bg)
    }

    // MARK: - Layout

    private var columns: [GridItem] {
        switch layout {
        case .phone:
            return Array(repeating: GridItem(.flexible(), spacing: gridGap), count: 3)
        case .tablet:
            return Array(repeating: GridItem(.flexible(), spacing: gridGap), count: 5)
        case .desktop:
            return [GridItem(.adaptive(minimum: 180), spacing: gridGap)]
        }
    }

    private var gridGap: CGFloat {
        layout == .phone ? 2 : 4
    }

    private var outerHorizontalPadding: CGFloat {
        switch layout {
        case .phone:   return 2
        case .tablet:  return 8
        case .desktop: return 12
        }
    }
}

// MARK: - LibraryFolderCell

/// Square sub-folder tile for the phone Library grid. Sized to match the
/// square image cells (`LibraryCell`) so folder + image rows stay aligned
/// in the edge-bleed grid. Tap drills into the folder. (BrowseGrid uses
/// its own 3:2 `FolderCell` for the desktop explorer; the phone grid is
/// square, so it gets this variant rather than reusing that one.)
private struct LibraryFolderCell: View {
    let url: URL
    let onNavigate: () -> Void

    var body: some View {
        Button(action: onNavigate) {
            RoundedRectangle(cornerRadius: 2)
                .fill(MapleTokens.surfaceAlt)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    Image(systemName: "folder.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(MapleTokens.primary.opacity(0.85))
                }
                .overlay(alignment: .bottomLeading) {
                    Text(url.lastPathComponent)
                        .font(MapleTokens.Typography.body)
                        .foregroundStyle(MapleTokens.textMain)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(6)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Folder \(url.lastPathComponent)")
    }
}

#endif
