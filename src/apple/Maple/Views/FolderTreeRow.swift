// FolderTreeRow.swift — expandable, Finder-style row for saved local
// folders and their descendants, rendered by `LibrarySidebar`.
//
// Extracted out of LibrarySidebar.swift (Maple UI adoption epic #3019, MA4)
// into its own file alongside its Cloud twin, `CloudFolderTreeRow.swift` —
// the two rows already mirror each other's shape one-for-one (see that
// file's header) and now share the same `MuiTreeRow`-based row shell.
//
// Recursive tree view of saved folders and their descendants. Sub-folder
// rows are enumerated lazily: the chevron toggles expansion; children are
// loaded on demand via `enumerateChildren`. Auto-expands along the ancestor
// path of the currently-selected folder so the tree always shows where the
// grid is.
//
// Security scope is claimed at every depth (not just the root) — the claim
// is cheap and scoped to a single directory read, so SwiftUI lifecycle
// cannot drop the claim mid-enumeration.

import SwiftUI
import MapleCore
import MapleUI
#if os(macOS)
import AppKit
#endif

struct FolderTreeRow: View {
    let url: URL
    let displayName: String
    /// Bookmark of the nearest saved ancestor; used to re-claim security
    /// scope before any directory read at any depth.
    let rootBookmark: Data
    /// 0 = top-level saved folder; >0 = lazy descendant row. Controls
    /// indent and whether the row offers the "Remove from list" action.
    let depth: Int
    /// Currently-selected folder's absolute path. A row that is an ancestor
    /// of this path will auto-expand on appear.
    let selectedPath: String?
    /// Bumped after a New Folder / Rename / Trash action commits anywhere
    /// in the tree — re-enumerates this row's children if expanded, so a
    /// change made via the context menu shows up without a manual
    /// collapse/re-expand.
    var refreshGeneration: Int = 0
    /// Click handler — any depth. Caller decides whether the URL is the
    /// saved root or a descendant.
    let onPick: (URL) -> Void
    /// Only fires for depth == 0.
    let onRemove: (() -> Void)?
    /// Source-tree context menu (#2645). `onCreateFolder`/`onTrashFolder`
    /// take (url, rootBookmark); `onRenameFolder` additionally takes the
    /// new name.
    var onCreateFolder: ((URL, Data, String) -> Void)? = nil
    var onRenameFolder: ((URL, Data, String) -> Void)? = nil
    var onTrashFolder: ((URL, Data) -> Void)? = nil
    /// "Show Trash…" (#2653) — depth == 0 only (the saved-folder root), and
    /// only ever wired on iOS/iPadOS: macOS Filesystem sources use the real
    /// OS Trash and have no in-app Trash node (see `AppShell+Trash.swift`'s
    /// file header). `nil` suppresses the menu item.
    var onShowTrash: ((URL, Data, String) -> Void)? = nil
    /// Drag-onto-source-tree (#2646). See `LibrarySidebar.onDropAssets`'s
    /// doc comment for the `ids == nil` ⇒ "use current grid selection"
    /// contract.
    var onDropAssets: (URL, Data, Set<AssetRef.ID>?, Bool) -> Void = { _, _, _, _ in }
    /// OS file/folder drop-to-mount (#2649). See `LibrarySidebar.onDropURLs`'s
    /// doc comment for why this row needs its OWN `URL.self` drop target
    /// rather than relying on a window-level one.
    var onDropURLs: ([URL]) -> Bool = { _ in false }
    /// Gates the "Move/Copy Selected Here" context-menu items.
    var selectedAssetCount: Int = 0

    @State private var expanded = false
    @State private var children: [URL] = []
    @State private var didEnumerate = false
    @State private var showNewFolderAlert = false
    @State private var newFolderDraft = ""
    @State private var showRenameAlert = false
    @State private var renameDraft = ""
    @State private var showTrashConfirm = false
    @State private var isDropTargeted = false

    private var isSelected: Bool { selectedPath == url.path }
    private var isAncestorOfSelection: Bool {
        guard let selectedPath, selectedPath != url.path else { return false }
        let rootComponents = url.pathComponents
        let selectedComponents = URL(fileURLWithPath: selectedPath).pathComponents
        guard selectedComponents.count > rootComponents.count else { return false }
        return Array(selectedComponents.prefix(rootComponents.count)) == rootComponents
    }
    private var newFolderDraftIsValid: Bool {
        FilenameValidation.isValidPathComponent(newFolderDraft.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    private var renameDraftIsValid: Bool {
        FilenameValidation.isValidPathComponent(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    /// Optimistic chevron rule — same contract as `CloudFolderTreeRow.hasChildren`:
    /// shows a chevron until enumeration proves the folder is a leaf.
    private var hasChildren: Bool {
        !(didEnumerate && children.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Row shell — MapleUI's `MuiTreeRow` (Maple UI adoption epic
            // #3019, MA4), replacing the hand-rolled chevron-Button +
            // folder-icon-Button pair this row used to compose directly.
            // Mirror of `CloudFolderTreeRow`'s row shell exactly. Everything
            // below (drag/drop targets, context menu, alerts) attaches as
            // external modifiers, since `MuiTreeRow` only owns the row's
            // own chrome.
            MuiTreeRow(
                label: displayName,
                icon: "folder",
                expandable: hasChildren,
                expanded: Binding(
                    get: { expanded },
                    set: { newValue in
                        withAnimation(.easeInOut(duration: 0.12)) {
                            expanded = newValue
                            if expanded && !didEnumerate { enumerateChildren() }
                        }
                    }
                ),
                depth: depth,
                active: isSelected,
                pressed: { onPick(url) }
            )
            // Overlay, not background: MuiTreeRow paints its own opaque active
      // background, which would hide a background-layer drop highlight when
      // the drop target is also the selected row.
      .overlay(
        RoundedRectangle(cornerRadius: MapleTokens.Radius.sm)
          .fill(isDropTargeted ? MapleTokens.primary.opacity(0.15) : Color.clear)
          .allowsHitTesting(false)
      )
            // Drag-onto-source-tree (#2646). Default = move; the platform
            // copy-modifier (Option on macOS — see `MapleDragModifier`) =
            // copy. `payloads.first` is safe: a `.draggable` drag session
            // carries exactly one `DraggedAssetPayload` (itself a LIST of
            // ids for a multi-select drag), never multiple payloads.
            .dropDestination(for: DraggedAssetPayload.self, action: { payloads, _ in
                guard let payload = payloads.first, !payload.ids.isEmpty else { return false }
                onDropAssets(url, rootBookmark, Set(payload.ids), MapleDragModifier.isCopyRequested())
                return true
            }, isTargeted: { targeted in isDropTargeted = targeted })
            // Second, same-view drop target for OS file/folder drops (#2649)
            // — a distinct type from `DraggedAssetPayload` above, so this is
            // an ADDITIONAL registered type on this same drop target, not a
            // competing nested one; see `LibrarySidebar.onDropURLs`.
            .urlDropDestination(perform: onDropURLs)
            .contextMenu {
                if selectedAssetCount > 0 {
                    Button {
                        onDropAssets(url, rootBookmark, nil, false)
                    } label: {
                        Label("Move Selected Here", systemImage: "arrow.right.doc.on.clipboard")
                    }
                    .accessibilityIdentifier("folderTree.moveSelectedHere.\(url.path)")
                    Button {
                        onDropAssets(url, rootBookmark, nil, true)
                    } label: {
                        Label("Copy Selected Here", systemImage: "doc.on.doc")
                    }
                    .accessibilityIdentifier("folderTree.copySelectedHere.\(url.path)")
                    Divider()
                }
                if onCreateFolder != nil {
                    Button {
                        newFolderDraft = ""
                        showNewFolderAlert = true
                    } label: {
                        Label("New Folder", systemImage: "folder.badge.plus")
                    }
                    .accessibilityIdentifier("folderTree.newFolder.\(url.path)")
                }
                if onRenameFolder != nil {
                    Button {
                        renameDraft = displayName
                        showRenameAlert = true
                    } label: {
                        Label("Rename…", systemImage: "pencil")
                    }
                    .accessibilityIdentifier("folderTree.rename.\(url.path)")
                }
                if onTrashFolder != nil {
                    Button(role: .destructive) {
                        showTrashConfirm = true
                    } label: {
                        Label(Self.trashMenuTitle, systemImage: "trash")
                    }
                    .accessibilityIdentifier("folderTree.trash.\(url.path)")
                }
                #if os(macOS)
                // Reveal in Finder (#2658) — every row this view renders
                // (saved local folder, or a lazily-enumerated descendant)
                // carries a real on-disk `url`, so unlike the grid's
                // per-asset gating this needs no eligibility check at all:
                // FolderTreeRow only exists for local Filesystem sources.
                // macOS-only — there's no Finder on iOS/iPadOS, the other
                // platform this same row renders on.
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                } label: {
                    Label("Reveal in Finder", systemImage: "folder")
                }
                .accessibilityIdentifier("folderTree.revealInFinder.\(url.path)")
                #endif
                if depth == 0, let onShowTrash {
                    Button {
                        onShowTrash(url, rootBookmark, displayName)
                    } label: {
                        Label("Show Trash…", systemImage: "trash.circle")
                    }
                    .accessibilityIdentifier("folderTree.showTrash.\(url.path)")
                }
                if onRemove != nil, onCreateFolder != nil || onRenameFolder != nil || onTrashFolder != nil || onShowTrash != nil {
                    Divider()
                }
                if let onRemove {
                    Button("Remove from list", role: .destructive, action: onRemove)
                }
            }
            .alert("New Folder", isPresented: $showNewFolderAlert) {
                TextField("Name", text: $newFolderDraft)
                Button("Create") {
                    let name = newFolderDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard FilenameValidation.isValidPathComponent(name) else { return }
                    onCreateFolder?(url, rootBookmark, name)
                }
                .disabled(!newFolderDraftIsValid)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(newFolderDraftIsValid
                    ? "Creates a new folder inside \(displayName)."
                    : FilenameValidation.invalidNameMessage)
            }
            .alert("Rename Folder", isPresented: $showRenameAlert) {
                TextField("Name", text: $renameDraft)
                Button("Rename") {
                    let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard FilenameValidation.isValidPathComponent(name), name != displayName else { return }
                    onRenameFolder?(url, rootBookmark, name)
                }
                .disabled(!renameDraftIsValid)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(renameDraftIsValid ? " " : FilenameValidation.invalidNameMessage)
            }
            .confirmationDialog(Self.trashMenuTitle, isPresented: $showTrashConfirm, titleVisibility: .visible) {
                Button(Self.trashMenuTitle, role: .destructive) {
                    onTrashFolder?(url, rootBookmark)
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(Self.trashConfirmMessage(displayName))
            }

            if expanded {
                ForEach(children, id: \.self) { childURL in
                    FolderTreeRow(
                        url: childURL,
                        displayName: childURL.lastPathComponent,
                        rootBookmark: rootBookmark,
                        depth: depth + 1,
                        selectedPath: selectedPath,
                        refreshGeneration: refreshGeneration,
                        onPick: onPick,
                        onRemove: nil,
                        onCreateFolder: onCreateFolder,
                        onRenameFolder: onRenameFolder,
                        onTrashFolder: onTrashFolder,
                        onDropAssets: onDropAssets,
                        onDropURLs: onDropURLs,
                        selectedAssetCount: selectedAssetCount
                    )
                }
            }
        }
        .accessibilityLabel(displayName)
        .onChange(of: refreshGeneration) { _, _ in
            if expanded { enumerateChildren() }
        }
        .task {
            // Auto-expand if this row is on the ancestor path of the
            // currently-selected folder — keeps the tree in sync with the
            // grid without any user-facing enumeration cost.
            if !expanded && isAncestorOfSelection {
                if !didEnumerate { enumerateChildren() }
                expanded = true
            }
        }
        // `.task` only fires once per view identity, so it misses when the
        // user drills into a sub-folder via the grid *after* this row is
        // already on screen (the original bug). `.onChange(of: selectedPath)`
        // re-runs whenever the selection moves, which is exactly when the
        // tree may need to unfold to keep its highlight in sync with the
        // grid.
        .onChange(of: selectedPath) { _, _ in
            if !expanded && isAncestorOfSelection {
                if !didEnumerate { enumerateChildren() }
                withAnimation(.easeInOut(duration: 0.12)) {
                    expanded = true
                }
            }
        }
    }

    /// List immediate sub-folders inside `url`. Re-resolves the root
    /// bookmark and claims security scope at every depth; ancestor rows
    /// may have been torn down by SwiftUI so we can't assume scope is
    /// already open.
    private func enumerateChildren() {
        var isStale = false
        let resolvedRoot = try? URL(
            resolvingBookmarkData: rootBookmark,
            options: Self.bookmarkResolutionOptions,
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
        let accessing = resolvedRoot?.startAccessingSecurityScopedResource() ?? false
        defer {
            if accessing { resolvedRoot?.stopAccessingSecurityScopedResource() }
        }
        let fm = FileManager.default
        let contents = (try? fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        children = contents.filter {
            !$0.lastPathComponent.hasPrefix(".")
            && ((try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true)
        }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        didEnumerate = true
    }

    private static var bookmarkResolutionOptions: URL.BookmarkResolutionOptions {
        #if os(macOS)
        return .withSecurityScope
        #else
        return []
        #endif
    }

    /// macOS routes a Filesystem-source delete through the real OS Trash
    /// (`FileManager.trashItem`); iOS/iPadOS has no OS trash for a
    /// security-scoped folder and falls back to `.maple/trash` under the
    /// library root. The design doc calls this asymmetry deliberate but
    /// requires it stay visible rather than silently different — the menu
    /// label and confirmation both name the actual destination.
    private static var trashMenuTitle: String {
        #if os(macOS)
        "Move to Trash"
        #else
        "Move to Maple's Trash"
        #endif
    }

    private static func trashConfirmMessage(_ name: String) -> String {
        #if os(macOS)
        "\"\(name)\" and everything inside it will move to the Trash. Recursive — every asset and sidecar underneath goes too."
        #else
        // No auto-purge claim: the 30-day sweep is #2653's mechanism and does
        // not exist on Apple yet — the dialog must not promise it before then.
        "\"\(name)\" and everything inside it will move to Maple's in-app Trash (.maple/trash). Recursive — every asset and sidecar underneath goes too."
        #endif
    }
}
