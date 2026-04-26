// LibrarySidebar.swift — Left panel. Ports the mockup's tree-style layout
// (docs/photo_app_mockup_v2.html, lines ~82-189):
//
//   Folders (+ button)                 ← SavedFolderStore-backed LRU
//     empty:  "No local folders" / "Add one"
//     list:   saved folders with DisclosureGroup for sub-folders (1 level)
//
//   Photos Library                     ← PhotoKitLibrary + PhotoKitSource filters
//     auth-denied:  "Grant Photos access" row
//     auth-granted: All Photos, Favorites, Picks, Rejects
//                   Albums — from PHAssetCollection.fetchAssetCollections(.album)
//
//   Connections                        ← SMB + SelfHosted known-entry lists
//     Network (SMB) — saved shares auto-connect via Keychain
//     Self Hosted   — saved servers auto-connect via Keychain token
//
// Selection state is UI-only (`@Binding var selection: LibrarySelection`).
// Callbacks fire when a row is activated; the shell does the actual work.

import SwiftUI
import Photos
import MapleCore

// MARK: - LibrarySidebar

struct LibrarySidebar: View {
    @Binding var selection: LibrarySelection

    // Row-activation callbacks — the shell owns the actual source-load logic.
    let onAddFolder: () -> Void
    let onPickFolder: (SavedFolder) -> Void
    let onRemoveFolder: (SavedFolder) -> Void
    /// Invoked when the user taps a breadcrumb ancestor inside a saved
    /// folder. The shell resolves the passed bookmark for security scope
    /// and loads that URL's immediate contents into the grid.
    let onPickAncestor: (URL, Data) -> Void
    let onPickPhotosFilter: (PhotoKitFilter) -> Void
    let onRequestPhotosAccess: () -> Void
    let onAddSMB: () -> Void
    let onPickSMB: (SMBCredentialStore.SavedShare) -> Void
    let onAddSelfHosted: () -> Void
    let onPickSelfHosted: (URL) -> Void

    // Section-open state (mockup: chevron open/closed).
    @State private var showFolders = true
    @State private var showPhotos = true
    @State private var showConnections = true

    // Cached PhotoKit state. Re-read in `.task`; PhotoKit authorization cannot
    // be observed directly so we poll on appearance.
    @State private var photosStatus: PHAuthorizationStatus = .notDetermined
    @State private var albums: [PhotoKitAlbum] = []

    // Saved folders + connections are read from UserDefaults/Keychain on
    // appearance. UserDefaults changes trigger a reload via `refreshFolders()`
    // which the shell can invoke through `NotificationCenter` if needed.
    @State private var savedFolders: [SavedFolder] = []
    @State private var savedShares: [SMBCredentialStore.SavedShare] = []
    @State private var savedServers: [URL] = []

    /// Token returned by `PhotoKitChangeObserver.subscribe` — held for the
    /// view's lifetime so we can unsubscribe in `.task`'s cancellation.
    @State private var photosChangeToken: UUID?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                foldersSection
                separator
                photosSection
                separator
                connectionsSection
            }
            .padding(.vertical, 4)
        }
        .background(MapleTokens.sidebar)
        .task {
            await refreshAll()
            // Subscribe to library-change notifications so albums refresh
            // the moment the user adds/removes one in another app.
            // Subscriptions live on a process-wide singleton observer that
            // PhotoKit registers exactly once per process; safe to call
            // every appearance.
            let token = PhotoKitChangeObserver.shared.subscribe {
                Task { @MainActor in
                    await refreshAll()
                }
            }
            photosChangeToken = token
        }
        // `.task` is implicitly cancelled when the view leaves the hierarchy;
        // unsubscribe alongside it. Without explicit cleanup the singleton
        // would accumulate dead handler references on every view rebuild.
        .onDisappear {
            if let token = photosChangeToken {
                PhotoKitChangeObserver.shared.unsubscribe(token)
                photosChangeToken = nil
            }
        }
        // Refresh the saved-folders list the moment the store changes — so a
        // folder just picked via .fileImporter shows up without a restart.
        .onReceive(
            NotificationCenter.default.publisher(for: SavedFolderStore.changedNotification)
        ) { _ in
            savedFolders = SavedFolderStore.load()
        }
    }

    // MARK: - Sections

    private var foldersSection: some View {
        Section {
            if showFolders {
                if savedFolders.isEmpty {
                    emptyFolders
                } else {
                    ForEach(savedFolders) { folder in
                        FolderTreeRow(
                            url: URL(fileURLWithPath: folder.path),
                            displayName: folder.displayName,
                            rootBookmark: folder.bookmark,
                            depth: 0,
                            selectedPath: selectedPathBinding,
                            onPick: { url in
                                if url.path == folder.path {
                                    selection = .folder(path: folder.path)
                                    onPickFolder(folder)
                                } else {
                                    selection = .folder(path: url.path)
                                    onPickAncestor(url, folder.bookmark)
                                }
                            },
                            onRemove: {
                                onRemoveFolder(folder)
                                refreshFolders()
                            }
                        )
                    }
                }
            }
        } header: {
            SectionHeaderRow(
                title: "Folders",
                isOpen: $showFolders,
                trailing: {
                    AddButton(action: onAddFolder)
                        .accessibilityLabel("Add folder")
                }
            )
        }
    }

    private var emptyFolders: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No local folders")
                .font(.system(size: 11))
                .foregroundStyle(MapleTokens.textMuted)
            Button("Add one", action: onAddFolder)
                .buttonStyle(.plain)
                .font(.system(size: 11))
                .foregroundStyle(MapleTokens.primary)
                .underline()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var photosSection: some View {
        // The sidebar always shows the Photos Library filters, regardless of
        // authorisation status. Clicking one selects the filter but does NOT
        // trigger `PHPhotoLibrary.requestAuthorization` — the permission prompt
        // is fired only from the grid's empty-state "Grant Access" button, so
        // a first-time user isn't ambushed by a permission dialog just from
        // navigating the sidebar.
        Section {
            if showPhotos {
                NavItem(
                    icon: "photo.on.rectangle",
                    label: "All Photos",
                    isSelected: selection == .photosFilter(.all)
                ) {
                    selection = .photosFilter(.all)
                    onPickPhotosFilter(.all)
                }
                NavItem(
                    icon: "star",
                    label: "Favorites",
                    isSelected: selection == .photosFilter(.favorites)
                ) {
                    selection = .photosFilter(.favorites)
                    onPickPhotosFilter(.favorites)
                }
                NavItem(
                    icon: "checkmark",
                    label: "Picks",
                    isSelected: selection == .photosFilter(.picks)
                ) {
                    selection = .photosFilter(.picks)
                    onPickPhotosFilter(.picks)
                }
                NavItem(
                    icon: "xmark",
                    label: "Rejects",
                    isSelected: selection == .photosFilter(.rejects)
                ) {
                    selection = .photosFilter(.rejects)
                    onPickPhotosFilter(.rejects)
                }
                if photosStatus == .authorized || photosStatus == .limited {
                    albumsSubsection
                }
            }
        } header: {
            SectionHeaderRow(title: "Photos Library", isOpen: $showPhotos)
        }
    }

    @ViewBuilder
    private var albumsSubsection: some View {
        // Thin separator + small-caps "Albums" subheader, per the mockup.
        Rectangle()
            .fill(MapleTokens.border)
            .frame(height: 0.5)
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        Text("ALBUMS")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(MapleTokens.textMuted)
            .tracking(0.6)
            .padding(.horizontal, 24)
            .padding(.vertical, 2)
        if albums.isEmpty {
            Text("No albums")
                .font(.system(size: 11))
                .foregroundStyle(MapleTokens.textMuted)
                .padding(.horizontal, 24)
                .padding(.vertical, 4)
        } else {
            ForEach(albums) { album in
                NavItem(
                    icon: "square.stack",
                    label: album.title,
                    isSelected: selection == .photosFilter(.album(id: album.id, title: album.title))
                ) {
                    let f = PhotoKitFilter.album(id: album.id, title: album.title)
                    selection = .photosFilter(f)
                    onPickPhotosFilter(f)
                }
            }
        }
    }

    @ViewBuilder
    private var connectionsSection: some View {
        Section {
            if showConnections {
                // SMB group
                DisclosureRow(
                    icon: "network",
                    label: "Network (SMB)",
                    hasChildren: !savedShares.isEmpty,
                    onAdd: onAddSMB
                ) {
                    ForEach(savedShares, id: \.self) { share in
                        NavItem(
                            icon: "externaldrive.connected.to.line.below",
                            label: "\(share.host) / \(share.share)",
                            isSelected: selection == .smbShare(share),
                            indent: 32
                        ) {
                            selection = .smbShare(share)
                            onPickSMB(share)
                        }
                    }
                }
                // Self-hosted group — hidden entirely until at least one
                // server has been paired. New-server pairing lives in
                // Settings (macOS) / iOS Settings sheet. Once a server is
                // saved, this section appears with it listed.
                if !savedServers.isEmpty {
                    DisclosureRow(
                        icon: "cloud",
                        label: "Self Hosted",
                        hasChildren: true,
                        onAdd: nil
                    ) {
                        ForEach(savedServers, id: \.self) { url in
                            NavItem(
                                icon: "server.rack",
                                label: url.host ?? url.absoluteString,
                                isSelected: selection == .selfHostedServer(url),
                                indent: 32
                            ) {
                                selection = .selfHostedServer(url)
                                onPickSelfHosted(url)
                            }
                        }
                    }
                }
            }
        } header: {
            SectionHeaderRow(title: "Connections", isOpen: $showConnections)
        }
    }

    private var separator: some View {
        Rectangle()
            .fill(MapleTokens.border)
            .frame(height: 0.5)
            .padding(.vertical, 4)
    }

    // MARK: - Refresh

    /// Re-read persistent stores. Called on `.task` appearance.
    private func refreshAll() async {
        photosStatus = PhotoKitLibrary.authorizationStatus()
        refreshFolders()
        savedShares = await SMBCredentialStore.shared.savedShares()
        savedServers = await SelfHostedCredentialStore.shared.knownServers()
        if photosStatus == .authorized || photosStatus == .limited {
            albums = PhotoKitLibrary.userAlbums()
        }
    }

    private func refreshFolders() {
        savedFolders = SavedFolderStore.load()
    }

    /// Extract the currently-selected folder path (top-level or sub-folder)
    /// so `FolderTreeRow` can highlight the right row at any depth.
    private var selectedPathBinding: String? {
        if case .folder(let path) = selection { return path }
        return nil
    }
}

// MARK: - SectionHeaderRow

private struct SectionHeaderRow<Trailing: View>: View {
    let title: String
    @Binding var isOpen: Bool
    @ViewBuilder let trailing: () -> Trailing

    init(title: String, isOpen: Binding<Bool>,
         @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.title = title
        self._isOpen = isOpen
        self.trailing = trailing
    }

    var body: some View {
        Button(action: { withAnimation(.easeInOut(duration: 0.15)) { isOpen.toggle() } }) {
            HStack(spacing: 4) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(MapleTokens.textMuted)
                    .rotationEffect(.degrees(isOpen ? 0 : -90))
                Text(title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MapleTokens.textMuted)
                Spacer()
                trailing()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - AddButton

private struct AddButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(MapleTokens.textMuted)
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - NavItem

private struct NavItem: View {
    let icon: String
    let label: String
    let isSelected: Bool
    var indent: CGFloat = 24
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                    .foregroundStyle(isSelected ? MapleTokens.primary : MapleTokens.textMuted)
                    .frame(width: 14)
                Text(label)
                    .font(.system(size: 11))
                    .foregroundStyle(isSelected ? MapleTokens.primary : MapleTokens.textMain)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
            }
            .padding(.leading, indent)
            .padding(.trailing, 10)
            .padding(.vertical, 4)
            .background(isSelected ? MapleTokens.bgActive : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

// MARK: - FolderTreeRow (expandable, Finder-style)
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

private struct FolderTreeRow: View {
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
    /// Click handler — any depth. Caller decides whether the URL is the
    /// saved root or a descendant.
    let onPick: (URL) -> Void
    /// Only fires for depth == 0.
    let onRemove: (() -> Void)?

    @State private var expanded = false
    @State private var children: [URL] = []
    @State private var didEnumerate = false

    private var isSelected: Bool { selectedPath == url.path }
    private var isAncestorOfSelection: Bool {
        guard let selectedPath, selectedPath != url.path else { return false }
        let rootComponents = url.pathComponents
        let selectedComponents = URL(fileURLWithPath: selectedPath).pathComponents
        guard selectedComponents.count > rootComponents.count else { return false }
        return Array(selectedComponents.prefix(rootComponents.count)) == rootComponents
    }
    private var indent: CGFloat { 10 + CGFloat(depth) * 14 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.12)) {
                        expanded.toggle()
                        if expanded && !didEnumerate { enumerateChildren() }
                    }
                }) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(MapleTokens.textMuted)
                        .opacity(didEnumerate && children.isEmpty ? 0.15 : 0.5)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 10, height: 10)
                }
                .buttonStyle(.plain)
                .disabled(didEnumerate && children.isEmpty)

                Button(action: { onPick(url) }) {
                    HStack(spacing: 6) {
                        Image(systemName: "folder")
                            .font(.system(size: 10))
                            .foregroundStyle(isSelected ? MapleTokens.primary : MapleTokens.textMuted)
                        Text(displayName)
                            .font(.system(size: 11))
                            .foregroundStyle(isSelected ? MapleTokens.primary : MapleTokens.textMain)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.leading, indent)
            .padding(.trailing, 10)
            .padding(.vertical, 4)
            .background(isSelected ? MapleTokens.bgActive : Color.clear)
            .contextMenu {
                if let onRemove {
                    Button("Remove from list", role: .destructive, action: onRemove)
                }
            }

            if expanded {
                ForEach(children, id: \.self) { childURL in
                    FolderTreeRow(
                        url: childURL,
                        displayName: childURL.lastPathComponent,
                        rootBookmark: rootBookmark,
                        depth: depth + 1,
                        selectedPath: selectedPath,
                        onPick: onPick,
                        onRemove: nil
                    )
                }
            }
        }
        .accessibilityLabel(displayName)
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
}

// MARK: - SavedFolderRow (unused — kept for reference, legacy breadcrumb)
//
// The sidebar renders the saved top-level folder PLUS a chain of its
// ancestors down to the currently-open sub-folder — so the sidebar always
// mirrors what the grid is showing. No filesystem walk: the breadcrumb is
// derived purely from `selectedPath`'s URL path components. When the user
// is browsing the saved root itself, only one row shows.

private struct SavedFolderRow: View {
    let folder: SavedFolder
    /// Absolute path of the currently-selected folder. May be a descendant
    /// of `folder.path`, the root itself, or unrelated (in which case we
    /// render only the saved root row).
    let selectedPath: String?
    /// Tap on the saved root row.
    let onTap: () -> Void
    /// Tap on a breadcrumb ancestor row (a folder inside the saved root).
    let onTapAncestor: (URL) -> Void
    let onRemove: () -> Void

    /// URLs from the saved root down to `selectedPath`, inclusive of both
    /// ends. If `selectedPath` is not a descendant of the saved root, the
    /// chain collapses to just the root.
    private var chain: [URL] {
        let root = URL(fileURLWithPath: folder.path)
        guard let selected = selectedPath, selected != folder.path else {
            return [root]
        }
        let rootComponents = root.pathComponents
        let selectedURL = URL(fileURLWithPath: selected)
        let selectedComponents = selectedURL.pathComponents
        // Must be strictly a descendant of root; otherwise collapse.
        guard selectedComponents.count > rootComponents.count,
              Array(selectedComponents.prefix(rootComponents.count)) == rootComponents
        else {
            return [root]
        }
        var urls: [URL] = [root]
        for i in rootComponents.count..<selectedComponents.count {
            urls.append(urls.last!.appendingPathComponent(selectedComponents[i]))
        }
        return urls
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(chain.indices, id: \.self) { i in
                let url = chain[i]
                let depth = i
                row(url: url, depth: depth, isRoot: depth == 0)
            }
        }
    }

    @ViewBuilder
    private func row(url: URL, depth: Int, isRoot: Bool) -> some View {
        let isSelected = (selectedPath == url.path) || (selectedPath == nil && isRoot)
        let label = isRoot ? folder.displayName : url.lastPathComponent

        Button {
            if isRoot { onTap() } else { onTapAncestor(url) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.system(size: 10))
                    .foregroundStyle(isSelected ? MapleTokens.primary : MapleTokens.textMuted)
                Text(label)
                    .font(.system(size: 11))
                    .foregroundStyle(isSelected ? MapleTokens.primary : MapleTokens.textMain)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, 12 + CGFloat(depth) * 14)
        .padding(.trailing, 10)
        .padding(.vertical, 5)
        .background(isSelected ? MapleTokens.bgActive : Color.clear)
        .contextMenu {
            if isRoot {
                Button("Remove from list", role: .destructive, action: onRemove)
            }
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

// MARK: - DisclosureRow (connections)

private struct DisclosureRow<Content: View>: View {
    let icon: String
    let label: String
    let hasChildren: Bool
    /// When nil, the trailing "+" button is suppressed — used for read-only
    /// groups (e.g. Self Hosted, which gains new servers only via Settings).
    let onAdd: (() -> Void)?
    @ViewBuilder let content: () -> Content

    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                if hasChildren {
                    Button(action: { withAnimation(.easeInOut(duration: 0.12)) { expanded.toggle() } }) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(MapleTokens.textMuted)
                            .opacity(0.5)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .frame(width: 10, height: 10)
                    }
                    .buttonStyle(.plain)
                } else {
                    Spacer().frame(width: 10)
                }

                Button(action: { onAdd?() }) {
                    HStack(spacing: 6) {
                        Image(systemName: icon)
                            .font(.system(size: 10))
                            .foregroundStyle(MapleTokens.textMuted)
                        Text(label)
                            .font(.system(size: 11))
                            .foregroundStyle(MapleTokens.textMain)
                        Spacer()
                        if onAdd != nil {
                            Image(systemName: "plus")
                                .font(.system(size: 10))
                                .foregroundStyle(MapleTokens.textMuted)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(onAdd == nil)
            }
            .padding(.leading, 10)
            .padding(.trailing, 10)
            .padding(.vertical, 4)

            if expanded {
                content()
            }
        }
    }
}
