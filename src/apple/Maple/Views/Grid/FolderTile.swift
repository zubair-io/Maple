// FolderTile.swift — sub-folder tile shared by the Mac/iPad Browse grid and
// the iPhone Library grid (#3099).
//
// Mirrors the Windows `BrowseFolderTiles` template (MainWindow.xaml) so all
// three platforms render one folder design: a 180×64 landscape tile, 4pt
// radius, `surface` ground, no border; a 20pt folder outline in `primary`,
// a 10pt gap, then the folder name with a tail ellipsis, 14pt side padding.
// `FolderTileSection` wraps the tiles left-to-right above the photo grid
// (docs/spec/13-windows-shell.md § "Browse mode") and renders nothing when
// the directory has no subfolders.
//
// Replaces the two hand-rolled cells this consolidates: `BrowseGrid`'s 3:2
// `FolderCell` and `LibraryGrid`'s square `LibraryFolderCell`.

import SwiftUI
import MapleCore

/// A single sub-folder tile. Single tap navigates into the folder; the
/// button style gives press feedback (scale + tinted ground) before the
/// grid reloads.
///
/// Drop target (#2779): same payload / `isTargeted` highlight / `onDropAssets`
/// contract as the sidebar's `FolderTreeRow`, routed by the caller into
/// `AppShell.handleAssetDrop`. Active only when both `rootBookmark` and
/// `onDropAssets` are non-nil — the Browse grid passes both; the iPhone
/// Library (no drag source on phone) and previews pass neither.
struct FolderTile: View {
    static let width: CGFloat = 180
    static let height: CGFloat = 64
    static let cornerRadius: CGFloat = 4
    /// Gap between neighbouring tiles — the Windows template's 2px margin
    /// on each side.
    static let spacing: CGFloat = 4

    let url: URL
    var rootBookmark: Data? = nil
    var onDropAssets: ((URL, Data, Set<AssetRef.ID>?, Bool) -> Void)? = nil
    let onNavigate: () -> Void

    @State private var isDropTargeted = false

    var body: some View {
        Button(action: onNavigate) {
            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .font(.system(size: 20))
                    .foregroundStyle(MapleTokens.primary)
                Text(url.lastPathComponent)
                    .font(MapleTokens.Typography.body)
                    .foregroundStyle(MapleTokens.textMain)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(width: Self.width, height: Self.height)
            .background(
                MapleTokens.surface,
                in: RoundedRectangle(cornerRadius: Self.cornerRadius)
            )
            .overlay {
                if isDropTargeted {
                    RoundedRectangle(cornerRadius: Self.cornerRadius)
                        .fill(MapleTokens.primary.opacity(0.15))
                        .overlay(
                            RoundedRectangle(cornerRadius: Self.cornerRadius)
                                .strokeBorder(MapleTokens.primary, lineWidth: 2)
                        )
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: Self.cornerRadius))
        }
        .buttonStyle(FolderTileButtonStyle())
        .accessibilityLabel("Folder \(url.lastPathComponent)")
        .modifier(FolderDropTarget(
            url: url,
            rootBookmark: rootBookmark,
            onDropAssets: onDropAssets,
            isTargeted: $isDropTargeted
        ))
    }
}

/// Attaches the asset drop target only when the caller supplied both halves
/// of the drop contract; otherwise the tile is left untouched, so it can
/// never light up as a drop target it would then refuse.
private struct FolderDropTarget: ViewModifier {
    let url: URL
    let rootBookmark: Data?
    let onDropAssets: ((URL, Data, Set<AssetRef.ID>?, Bool) -> Void)?
    @Binding var isTargeted: Bool

    func body(content: Content) -> some View {
        if let rootBookmark, let onDropAssets {
            content.dropDestination(for: DraggedAssetPayload.self, action: { payloads, _ in
                guard let payload = payloads.first, !payload.ids.isEmpty else { return false }
                onDropAssets(url, rootBookmark, Set(payload.ids), MapleDragModifier.isCopyRequested())
                return true
            }, isTargeted: { targeted in isTargeted = targeted })
        } else {
            content
        }
    }
}

/// The folder block above a photo grid: `tiles` wrap left-to-right with a
/// ragged right edge (`FlowLayout`), leading-aligned, with the section gap
/// below so the first photo row reads as a separate block. Callers hide it
/// entirely (rather than passing an empty `ForEach`) when there are no
/// subfolders or while multi-selecting.
struct FolderTileSection<Tiles: View>: View {
    /// Gap between the folder block and the first photo row.
    static var sectionGap: CGFloat { 12 }

    @ViewBuilder let tiles: () -> Tiles

    var body: some View {
        FlowLayout(spacing: FolderTile.spacing) {
            tiles()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, Self.sectionGap)
    }
}

/// Press feedback for `FolderTile`. Scales down slightly and tints the
/// ground while the pointer/finger is down, easing back on release.
private struct FolderTileButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .background(
                RoundedRectangle(cornerRadius: FolderTile.cornerRadius)
                    .fill(configuration.isPressed ? MapleTokens.bgActive : .clear)
            )
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

#Preview("Folder tiles") {
    ScrollView {
        FolderTileSection {
            ForEach(["001_0360", "001_0361", "A much longer folder name that truncates", "001_0393"], id: \.self) { name in
                FolderTile(url: URL(fileURLWithPath: "/tmp/\(name)"), onNavigate: {})
            }
        }
        .padding(8)
    }
    .background(MapleTokens.bg)
    .frame(width: 600, height: 200)
}
