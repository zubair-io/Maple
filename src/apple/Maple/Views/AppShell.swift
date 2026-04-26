// AppShell.swift — Three-column NavigationSplitView (Mac/iPad) +
// TabView single-column collapse (iPhone).
//
// Layout ported from docs/photo_app_mockup_v2.html:
//   • LibrarySidebar   — Folders / Photos Library / Connections tree
//   • BrowseGrid       — lazy thumbnail grid with empty-state + error banner
//   • DetailPanel      — always visible (tabs stay, sliders disable without a session)
//
// Toolbar: search icon (leading, placeholder), dynamic "Library — <name>"
// title, Export button (trailing). ⌘O still opens the fileImporter;
// Open Folder has moved into the sidebar section header's "+" button.
//
// Keyboard shortcuts per spec § 09:
//   Stars 1-5, P/X/U flags — handled in BrowseGrid
//   Arrow navigation       — handled in BrowseGrid
//   ⌘E export              — triggers ExportPanel
//   ⌘O open folder         — fileImporter
//   ⌘\ sidebar toggle      — NavigationSplitView column visibility

import SwiftUI
import MapleCore
#if os(iOS)
import UIKit
#endif

// MARK: - AppShell

struct AppShell: View {
    @State private var browseVM = BrowseViewModel()
    @State private var sessions: [AssetRef.ID: EditSession] = [:]
    @State private var showExport = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showFilePicker = false

    // Sidebar selection (single active row across the whole tree).
    @State private var librarySelection: LibrarySelection = .none

    // Sheet state.
    @State private var showSMBSheet = false
    @State private var showSelfHostedSheet = false

    // Dynamic toolbar title — reflects the last-loaded source/filter.
    @State private var libraryTitle: String = "All"

    // Browse vs Full-image editor mode. Default to browse; a double-click on
    // an image cell flips this to .fullImage.
    private enum Mode { case browse, fullImage }
    @State private var mode: Mode = .browse

    // The root bookmark for the currently-open folder tree — used to claim
    // security scope when the user clicks a sub-folder cell inside the grid.
    @State private var currentRootBookmark: Data?

    // Active security scope for the current browse session. macOS sandbox
    // requires a scope-backed URL (resolved from a bookmark) to be "accessing"
    // for descendant reads to succeed. Detached render tasks outlive the call
    // that started them, so we hold the scope open for the whole time the
    // library is on this folder. `claimScope(for:)` releases the previous
    // claim and establishes a new one; release happens implicitly when the
    // next claim comes in or when `releaseScope()` is called on app exit.
    @State private var activeScopeURL: URL?

    private var selectedSession: EditSession? {
        browseVM.selectedID.flatMap { sessions[$0] }
    }

    var body: some View {
        Group {
            #if os(iOS)
            // iPad: three-column NavigationSplitView (matches Mac shell —
            // sidebar gives folder nav). iPhone: TabView single-column collapse.
            if UIDevice.current.userInterfaceIdiom == .pad {
                macShell
            } else {
                adaptiveShell
            }
            #else
            macShell
            #endif
        }
        .preferredColorScheme(.dark)
        .fileImporter(isPresented: $showFilePicker,
                      allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result {
                loadFolder(url: url)
            }
        }
        .sheet(isPresented: $showExport) {
            if let session = selectedSession {
                ExportPanel(session: session)
            }
        }
        .sheet(isPresented: $showSMBSheet) {
            SMBPickerSheet(onConnect: { creds in
                showSMBSheet = false
                connectSMB(credentials: creds)
            }, onCancel: { showSMBSheet = false })
        }
        .sheet(isPresented: $showSelfHostedSheet) {
            SelfHostedPickerSheet(onConnect: { url, token in
                showSelfHostedSheet = false
                connectSelfHosted(baseURL: url, token: token)
            }, onCancel: { showSelfHostedSheet = false })
        }
        .task {
            #if DEBUG
            // UITest harness fast path: if the launch env stashed a
            // fixture URL on `MapleApp.uitestFixtureURL`, seed the grid
            // with that single asset and flip directly into Full-image
            // mode so the test can wait on `canvas-render-ready`. Skips
            // restoreLastSource() entirely — the harness wants a known
            // empty starting state. See
            // docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md.
            if let fixtureURL = MapleApp.uitestFixtureURL {
                browseVM.loadSingleAsset(url: fixtureURL)
                if let asset = browseVM.assets.first {
                    let session = EditSession(asset: asset)
                    sessions[asset.id] = session
                    await session.loadSidecar()
                    browseVM.selectedID = asset.id
                    mode = .fullImage
                }
                return
            }
            #endif
            // Restore last-used source on cold start.
            await restoreLastSource()
        }
    }

    // MARK: - Mac / iPad (NavigationSplitView)

    private var macShell: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            LibrarySidebar(
                selection: $librarySelection,
                onAddFolder: { showFilePicker = true },
                onPickFolder: { folder in openSavedFolder(folder) },
                onRemoveFolder: { folder in SavedFolderStore.remove(path: folder.path) },
                onPickAncestor: { url, bookmark in
                    openSubFolder(url: url, rootBookmark: bookmark)
                },
                onPickPhotosFilter: { filter in loadPhotos(filter: filter) },
                onRequestPhotosAccess: { requestPhotosAccess() },
                onAddSMB: { showSMBSheet = true },
                onPickSMB: { share in connectSavedSMB(share) },
                onAddSelfHosted: { showSelfHostedSheet = true },
                onPickSelfHosted: { url in connectSavedSelfHosted(url) }
            )
            .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
        } content: {
            // The center column switches between the explorer grid (browse
            // mode) and the full-image editor (fullImage mode). Per the
            // mockup, these are two different center views — not a
            // side-by-side. Double-click on a thumbnail flips the mode.
            Group {
                switch mode {
                case .browse:
                    BrowseGrid(
                        vm: browseVM,
                        sessions: $sessions,
                        onGrantPhotosAccess: { grantPhotosAccessAndLoad() },
                        onNavigateFolder: { url in navigateFolder(url) },
                        onOpenEditor: { asset in openEditor(for: asset) },
                        onPrimeSession: { asset in ensureSession(for: asset) }
                    )
                case .fullImage:
                    if let session = selectedSession {
                        FullImageView(session: session)
                    } else {
                        // Fallback — if the session vanished while editing,
                        // drop back to browse.
                        Color.clear.onAppear { mode = .browse }
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 300, ideal: 520)
            .navigationTitle(mode == .fullImage
                             ? (selectedSession?.asset.displayName ?? "Image")
                             : "Library — \(libraryTitle)")
            .toolbar { browseToolbar }
        } detail: {
            // Detail panel is always in the right column per the mockup.
            // Sliders are disabled when no session is selected; Info tab
            // is the default when entering the app.
            //
            // Width: iPad expands the column toward `max` (~half the screen
            // when balanced), so we tighten the range there to just fit the
            // slider rail. macOS honors `ideal` and feels natural at 280pt.
            DetailPanel(session: selectedSession)
                .modifier(DetailPanelWidth())
        }
        .navigationSplitViewStyle(.balanced)
    }

    // MARK: - iPhone (TabView)

    private var adaptiveShell: some View {
        TabView {
            NavigationStack {
                BrowseGrid(
                    vm: browseVM,
                    sessions: $sessions,
                    onGrantPhotosAccess: { grantPhotosAccessAndLoad() },
                    onNavigateFolder: { url in navigateFolder(url) },
                    onOpenEditor: { asset in openEditor(for: asset) }
                )
                .navigationTitle("Library — \(libraryTitle)")
                .toolbar { browseToolbar }
            }
            .tabItem { Label("Browse", systemImage: "photo.on.rectangle") }

            NavigationStack {
                Group {
                    if let session = selectedSession {
                        FullImageView(session: session)
                            .navigationTitle(session.asset.displayName)
                    } else {
                        fullImagePlaceholder
                            .navigationTitle("Edit")
                    }
                }
            }
            .tabItem { Label("Edit", systemImage: "slider.horizontal.3") }

            NavigationStack {
                DetailPanel(session: selectedSession)
                    .navigationTitle("Info")
            }
            .tabItem { Label("Info", systemImage: "info.circle") }
        }
        .accentColor(MapleTokens.primary)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var browseToolbar: some ToolbarContent {
        // When editing, a Back-to-Library button takes over the leading
        // toolbar slot (escape also works).
        ToolbarItem(placement: .automatic) {
            if mode == .fullImage {
                Button("Back", systemImage: "chevron.left") {
                    mode = .browse
                }
                .keyboardShortcut(.escape, modifiers: [])
                .accessibilityLabel("Back to Library")
            } else {
                // TODO(UI-search): wire library search.
                Button {
                    // no-op
                } label: {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(MapleTokens.textMuted)
                }
                .accessibilityLabel("Search")
            }
        }
        ToolbarItem(placement: .automatic) {
            Button("Export", systemImage: "square.and.arrow.up") {
                showExport = true
            }
            .disabled(selectedSession == nil)
            .keyboardShortcut("e", modifiers: .command)
        }
        // ⌘O still works even though the button has moved into the sidebar.
        ToolbarItem(placement: .automatic) {
            Button("Open Folder", systemImage: "folder.badge.plus") {
                showFilePicker = true
            }
            .keyboardShortcut("o", modifiers: .command)
            // Hide from the visible toolbar — keyboard shortcut only.
            .hidden()
            .accessibilityHidden(true)
        }
    }

    // MARK: - Empty / placeholder views

    private var fullImagePlaceholder: some View {
        VStack(spacing: 14) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 48))
                .foregroundStyle(MapleTokens.textMuted)
            Text("No image selected")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(MapleTokens.textMain)
            Text("Pick a folder or a Photos library filter in the sidebar.")
                .font(.system(size: 11))
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.imageCanvas)
    }

    // MARK: - Folder flows

    @MainActor
    private func loadFolder(url: URL) {
        // Cancel any in-flight thumbnail decodes from the previous folder so
        // they don't keep burning CPU against files the user no longer sees.
        Task.detached { await ThumbnailLoader.shared.cancelAll() }
        // Configure folder-scoped caches so thumbnails land in the folder's
        // .maple/ directory (matches Maple Hosted).
        Task.detached {
            await ThumbnailDiskCache.shared.configure(folderURL: url)
            await RenderedPreviewCache.shared.configure(folderURL: url)
            await DecodedBufferCache.shared.configure(folderURL: url)
        }

        // Claim scope on the picker URL FIRST, before any filesystem read.
        // The URL from `.fileImporter` is scope-backed but sandboxed reads
        // require `startAccessingSecurityScopedResource()` to be active at
        // the moment the read happens — otherwise the sync listing below
        // fails with `fileReadUnknown`, `loadError` pops the red banner,
        // and yet the later `FilesystemSource.open` + `SavedFolderStore`
        // upsert still succeed (because those paths re-claim scope on
        // their own), so the folder ends up in the sidebar and usable —
        // but the user just saw a spurious "can't open folder" error.
        claimScope(for: url)

        // `url` here came from `.fileImporter` which returns a scope-backed
        // URL — propagate it to the VM so each synthesised AssetRef carries
        // the scope reference through to the pipeline / loader.
        browseVM.currentScopeRoot = url
        browseVM.loadFolder(url: url)
        librarySelection = .folder(path: url.path)
        libraryTitle = url.lastPathComponent
        mode = .browse

        for asset in browseVM.assets where sessions[asset.id] == nil {
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            Task { await session.loadSidecar() }
        }
        Task { @MainActor in
            let fs = FilesystemSource()
            do {
                try await fs.open(folderURL: url)
                if let data = await fs.persistableBookmark {
                    currentRootBookmark = data
                    SourceSelectionStore.save(.filesystem(bookmark: data))
                    SavedFolderStore.upsert(SavedFolder(
                        path: url.path,
                        displayName: url.lastPathComponent,
                        bookmark: data,
                        lastOpened: Date()
                    ))
                }
            } catch {
                // Non-fatal — next launch simply lands on the empty state.
            }
        }
    }

    /// Single-click on a sub-folder cell in the explorer grid. Navigates into
    /// the sub-folder using the currently-active root bookmark for security
    /// scope.
    @MainActor
    private func navigateFolder(_ url: URL) {
        guard let bookmark = currentRootBookmark else {
            // Fall back to a plain loadFolder — works for folders inside the
            // user's security-scope, fails silently for sandboxed reads.
            // Keep whatever scope root is already active.
            Task.detached { await ThumbnailLoader.shared.cancelAll() }
            browseVM.loadFolder(url: url)
            librarySelection = .folder(path: url.path)
            libraryTitle = url.lastPathComponent
            primeSessionsForCurrentAssets()
            return
        }
        openSubFolder(url: url, rootBookmark: bookmark)
    }

    /// Double-click on an image cell. Switches the center column to the
    /// full-image editor with that asset as the active session.
    @MainActor
    private func openEditor(for asset: AssetRef) {
        // Make sure the session exists (usually pre-created by primeSessions…).
        if sessions[asset.id] == nil {
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            Task { await session.loadSidecar() }
        }
        browseVM.selectedID = asset.id
        mode = .fullImage
    }

    /// Open a sub-folder inside a previously-saved top-level folder. Uses the
    /// root's bookmark to claim security scope (child URLs inherit it), loads
    /// the sub-folder's immediate children into the grid, and marks the
    /// sub-folder as the current library selection. Does NOT persist to
    /// `SavedFolderStore` — only top-level folders live in the recent list.
    @MainActor
    private func openSubFolder(url: URL, rootBookmark: Data) {
        librarySelection = .folder(path: url.path)
        libraryTitle = url.lastPathComponent
        currentRootBookmark = rootBookmark
        mode = .browse
        Task.detached { await ThumbnailLoader.shared.cancelAll() }
        Task.detached {
            await ThumbnailDiskCache.shared.configure(folderURL: url)
            await RenderedPreviewCache.shared.configure(folderURL: url)
            await DecodedBufferCache.shared.configure(folderURL: url)
        }
        Task { @MainActor in
            // Claim security scope via the root's bookmark. Child URLs live
            // inside the same scope on macOS, so a sandboxed read works.
            var isStale = false
            let rootURL: URL?
            #if os(macOS)
            rootURL = try? URL(
                resolvingBookmarkData: rootBookmark,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #else
            rootURL = try? URL(
                resolvingBookmarkData: rootBookmark,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #endif
            // Hold scope open for the whole browse session — the URL must be
            // bookmark-resolved (not built from `URL(fileURLWithPath:)`), so
            // we claim on `rootURL`. Sub-folder URLs inherit the scope.
            if let rootURL { claimScope(for: rootURL) }
            // Propagate the scope-backed root to the VM so synthesised
            // AssetRefs carry it (enables sandboxed Rust FFI reads).
            browseVM.currentScopeRoot = rootURL
            // Non-recursive walk of the sub-folder — the grid shows only
            // RAWs directly inside it, matching Finder-style drill-down.
            browseVM.loadFolder(url: url)
            primeSessionsForCurrentAssets()
        }
    }

    /// Re-open a folder the user previously picked, using its stored bookmark
    /// so we don't retrigger the system picker.
    @MainActor
    private func openSavedFolder(_ folder: SavedFolder) {
        librarySelection = .folder(path: folder.path)
        libraryTitle = folder.displayName
        currentRootBookmark = folder.bookmark
        mode = .browse
        Task.detached { await ThumbnailLoader.shared.cancelAll() }
        // Resolve the bookmark, claim security scope, then run the native
        // filesystem walker (which populates `subfolders` + `assets`). We
        // deliberately avoid `loadSource(fs)` here — that path is for sources
        // without a URL model (PhotoKit / SelfHosted) and doesn't surface
        // sub-folders.
        Task { @MainActor in
            var isStale = false
            let url: URL?
            #if os(macOS)
            url = try? URL(
                resolvingBookmarkData: folder.bookmark,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #else
            url = try? URL(
                resolvingBookmarkData: folder.bookmark,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #endif
            guard let folderURL = url else {
                browseVM.loadError = CocoaError(.fileReadNoPermission)
                return
            }
            // Hold scope open for the whole browse session — detached render
            // tasks (thumbnails, editor) need process-wide scope when they
            // eventually call into Rust. The previous `defer { stop }` released
            // before any of them ran, which is why Rust saw EPERM.
            claimScope(for: folderURL)
            // Scope-backed root for the VM so AssetRefs carry the token.
            browseVM.currentScopeRoot = folderURL
            await ThumbnailDiskCache.shared.configure(folderURL: folderURL)
            await RenderedPreviewCache.shared.configure(folderURL: folderURL)
            await DecodedBufferCache.shared.configure(folderURL: folderURL)
            browseVM.loadFolder(url: folderURL)
            SourceSelectionStore.save(.filesystem(bookmark: folder.bookmark))
            SavedFolderStore.upsert(SavedFolder(
                path: folder.path,
                displayName: folder.displayName,
                bookmark: folder.bookmark,
                lastOpened: Date()
            ))
            primeSessionsForCurrentAssets()
        }
    }

    // MARK: - PhotoKit

    @MainActor
    private func requestPhotosAccess() {
        Task { @MainActor in
            let status = await PhotoKitLibrary.requestAuthorization()
            if status == .authorized || status == .limited {
                loadPhotos(filter: .all)
            }
        }
    }

    @MainActor
    private func loadPhotos(filter: PhotoKitFilter) {
        librarySelection = .photosFilter(filter)
        libraryTitle = filter.title
        mode = .browse
        currentRootBookmark = nil
        // Selecting a Photos filter must not ambush the user with a permission
        // dialog. If PhotoKit isn't authorised yet, put the grid into the
        // "auth needed" empty state; the actual request happens when the user
        // taps the grid's "Grant Access" button.
        let status = PhotoKitLibrary.authorizationStatus()
        guard status == .authorized || status == .limited else {
            browseVM.setPhotosAuthNeeded()
            return
        }
        Task { @MainActor in
            let source = PhotoKitSource()
            do {
                try await source.fetchAssets(for: filter)
                await browseVM.loadSource(source)
                SourceSelectionStore.save(.photoKitFilter(filter))
                primeSessionsForCurrentAssets()
            } catch {
                browseVM.loadError = error
            }
        }
    }

    /// Fired by the grid's empty-state "Grant Access" button. Requests
    /// PhotoKit authorisation, then loads the currently-selected filter.
    @MainActor
    fileprivate func grantPhotosAccessAndLoad() {
        Task { @MainActor in
            let status = await PhotoKitLibrary.requestAuthorization()
            guard status == .authorized || status == .limited else { return }
            // User may have selected a filter before granting; fall back to .all.
            let filter: PhotoKitFilter
            if case .photosFilter(let f) = librarySelection { filter = f }
            else { filter = .all }
            loadPhotos(filter: filter)
        }
    }

    // MARK: - SMB

    @MainActor
    private func connectSMB(credentials: SMBSource.Credentials) {
        Task { @MainActor in
            try? await SMBCredentialStore.shared.save(credentials)

            let source = SMBSource()
            do {
                try await source.connect(credentials: credentials, remotePath: "/")
                await browseVM.loadSource(source)
                let share = SMBCredentialStore.SavedShare(
                    host: credentials.host,
                    share: credentials.share,
                    username: credentials.username
                )
                SourceSelectionStore.save(.smb(share))
                librarySelection = .smbShare(share)
                libraryTitle = "\(credentials.host) / \(credentials.share)"
                mode = .browse
                currentRootBookmark = nil
                primeSessionsForCurrentAssets()
            } catch {
                browseVM.loadError = error
            }
        }
    }

    @MainActor
    private func connectSavedSMB(_ share: SMBCredentialStore.SavedShare) {
        Task { @MainActor in
            if let creds = await SMBCredentialStore.shared.credentials(for: share) {
                connectSMB(credentials: creds)
            } else {
                // Keychain miss — re-prompt.
                showSMBSheet = true
            }
        }
    }

    // MARK: - Self Hosted

    @MainActor
    private func connectSelfHosted(baseURL: URL, token: String?) {
        Task { @MainActor in
            if let token {
                try? await SelfHostedCredentialStore.shared.setToken(token, forServerURL: baseURL)
            }

            let source = SelfHostedSource(baseURL: baseURL, token: token)
            await browseVM.loadSource(source)
            SourceSelectionStore.save(.selfHosted(baseURL: baseURL))
            librarySelection = .selfHostedServer(baseURL)
            libraryTitle = baseURL.host ?? baseURL.absoluteString
            mode = .browse
            currentRootBookmark = nil
            primeSessionsForCurrentAssets()
        }
    }

    @MainActor
    private func connectSavedSelfHosted(_ url: URL) {
        Task { @MainActor in
            if let token = await SelfHostedCredentialStore.shared.tokenForServerURL(url) {
                connectSelfHosted(baseURL: url, token: token)
            } else {
                // Keychain miss — re-prompt.
                showSelfHostedSheet = true
            }
        }
    }

    // MARK: - Restore

    @MainActor
    private func restoreLastSource() async {
        guard let selection = SourceSelectionStore.load() else { return }
        switch selection {
        case .filesystem(let bookmark):
            // Route through the same non-recursive folder-walk that
            // openSavedFolder uses — we want sub-folders + immediate images,
            // not a flattened descendant list.
            var isStale = false
            let url: URL?
            #if os(macOS)
            url = try? URL(
                resolvingBookmarkData: bookmark,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #else
            url = try? URL(
                resolvingBookmarkData: bookmark,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #endif
            guard let folderURL = url else {
                SourceSelectionStore.clear()
                return
            }
            // Hold scope for the whole session so detached render tasks work.
            claimScope(for: folderURL)
            currentRootBookmark = bookmark
            browseVM.currentScopeRoot = folderURL
            await ThumbnailDiskCache.shared.configure(folderURL: folderURL)
            await RenderedPreviewCache.shared.configure(folderURL: folderURL)
            await DecodedBufferCache.shared.configure(folderURL: folderURL)
            librarySelection = .folder(path: folderURL.path)
            libraryTitle = folderURL.lastPathComponent
            browseVM.loadFolder(url: folderURL)
            primeSessionsForCurrentAssets()
        case .photoKit, .photoKitFilter:
            // Do NOT auto-load Photos on cold start. The user opted into
            // PhotoKit in a previous session; that's no excuse to ambush them
            // with a library of thousands of images every launch. They click
            // a Photos filter explicitly if they want it this session.
            break
        case .smb(let share):
            connectSavedSMB(share)
        case .selfHosted(let baseURL):
            connectSavedSelfHosted(baseURL)
        }
    }

    @MainActor
    /// Lazy per-asset session creation. Called from `BrowseGrid`'s
    /// thumbnail-cell `.onAppear` so a session is built only when the
    /// cell scrolls into view, NOT eagerly across the entire folder.
    /// User reported on iPad: opening a 70-asset folder fired 70+
    /// `loadSidecar()` calls — every one a `CIRAWFilter` instantiation
    /// and an XMP store read for an asset the user might never tap.
    /// SwiftUI's `LazyVGrid` already defers cell instantiation; this
    /// closes the matching gap on the session model.
    private func ensureSession(for asset: AssetRef) {
        guard sessions[asset.id] == nil else { return }
        let session = EditSession(asset: asset)
        sessions[asset.id] = session
        Task { await session.loadSidecar() }
    }

    /// Eager prime — kept as a no-op shim for the call sites that used
    /// to invoke it. Sessions now materialise on cell appear via
    /// `ensureSession(for:)`. Removing the call sites entirely would
    /// be cleaner but expands the diff further than the scope of this
    /// fix; keep the empty body so the call sites still compile.
    private func primeSessionsForCurrentAssets() {
        // Intentionally empty. See `ensureSession(for:)` above.
    }

    // MARK: - Security scope lifecycle

    /// Claim security scope on the given URL for the whole current browse
    /// session. Releases any prior claim. `url` MUST be a bookmark-resolved
    /// URL (from `URL(resolvingBookmarkData:)`) — plain `URL(fileURLWithPath:)`
    /// is NOT scope-backed on macOS and the start call silently no-ops.
    @MainActor
    private func claimScope(for url: URL) {
        // Drop the prior claim first — reclaiming on the same URL is fine,
        // but we must release the old one before switching folders.
        releaseScope()
        let ok = url.startAccessingSecurityScopedResource()
        if ok { activeScopeURL = url }
    }

    @MainActor
    private func releaseScope() {
        if let prev = activeScopeURL {
            prev.stopAccessingSecurityScopedResource()
            activeScopeURL = nil
        }
    }
}

// MARK: - SMB sheet

struct SMBPickerSheet: View {
    let onConnect: (SMBSource.Credentials) -> Void
    let onCancel: () -> Void

    @State private var host = ""
    @State private var share = ""
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect to SMB Share")
                .font(.title3).bold()
            Form {
                TextField("Host (e.g. nas.local)", text: $host)
                TextField("Share name",           text: $share)
                TextField("Username",             text: $username)
                SecureField("Password",           text: $password)
            }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Connect") {
                    onConnect(SMBSource.Credentials(
                        host: host, share: share,
                        username: username, password: password
                    ))
                }
                .keyboardShortcut(.defaultAction)
                .disabled(host.isEmpty || share.isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 380)
    }
}

// MARK: - Detail panel width

/// Platform-scoped column width for the detail pane.
/// - macOS: 240/280/360 — generous, matches the mockup width.
/// - iPad: 240/260/280 — tightened because `NavigationSplitView` on iPad
///   pulls the column toward `max` and ignores `ideal`. Without this clamp
///   the detail pane eats roughly half the screen on a 12.9" iPad in
///   landscape, leaving the slider rail floating in whitespace.
private struct DetailPanelWidth: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        if UIDevice.current.userInterfaceIdiom == .pad {
            content.navigationSplitViewColumnWidth(min: 240, ideal: 260, max: 280)
        } else {
            content.navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 360)
        }
        #else
        content.navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 360)
        #endif
    }
}

// MARK: - Self-Hosted sheet

struct SelfHostedPickerSheet: View {
    let onConnect: (URL, String?) -> Void
    let onCancel: () -> Void

    @State private var serverURL = ""
    @State private var token = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect to Self-Hosted Server")
                .font(.title3).bold()
            Form {
                TextField("Server URL (e.g. https://maple.local)", text: $serverURL)
                SecureField("Bearer token (optional)", text: $token)
            }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Connect") {
                    guard let url = URL(string: serverURL) else { return }
                    onConnect(url, token.isEmpty ? nil : token)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(URL(string: serverURL) == nil)
            }
        }
        .padding(20)
        .frame(minWidth: 420)
    }
}
