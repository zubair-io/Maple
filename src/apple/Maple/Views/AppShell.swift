// AppShell.swift — root composition for the SwiftUI shell.
//
// This file is intentionally thin: it owns the cross-shell `@State`
// (selection, sessions, sheet flags, …) and stitches together three
// siblings that do the actual layout work:
//
//   • AppShellSidebar      — `LibrarySidebar` wrapper with all 13
//                            callbacks fanned out (file: AppShellSidebar.swift)
//   • AppShellMacLayout    — Mac/iPad NavigationSplitView, Browse +
//                            Full-image variants  (file: AppShellMacLayout.swift)
//   • AppShellIPhoneShell  — iPhone overlay drawer + center column + Info /
//                            Settings sheets (file: AppShellIPhoneShell.swift,
//                            #if os(iOS); wraps AppShellIPhoneDrawer)
//
// Action methods live in sibling extensions (slice 3):
//   • AppShell+FolderActions   — local folder source + sandbox scope
//   • AppShell+CloudActions    — Maple Cloud library + thumbnail wiring
//   • AppShell+PhotoKitActions — PhotoKit + SMB
//   • AppShell+UITestFixture   — UITest cold-start fast path (slice 6, #if DEBUG)
//
// Toolbar content is its own struct (slice 2):
//   • AppShellToolbar.swift     — shared Browse/Full-image content
//   • AppShellIPhoneToolbar.swift — iPhone-only hamburger + Info (slice 6, #if os(iOS))
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
    /// Resolves an `AuthSession` for a Self-Hosted server URL (created +
    /// bootstrapped on first request, cached at the `MapleApp` scope).
    /// Plan 2026-04-28-passkey-auth Task B8.
    let sessionFor: @MainActor (URL) -> AuthSession

    @MainActor
    init(sessionFor: @escaping @MainActor (URL) -> AuthSession = AppShell.defaultSessionResolver) {
        self.sessionFor = sessionFor
    }

    /// Fallback for previews / tests — not cached across calls. Production
    /// path always passes the real resolver from `MapleApp`. Hoisted to a
    /// static method so the `init` default can reference it without
    /// constructing an `AuthSession` from a non-MainActor synchronous
    /// closure (which the compiler rejects).
    @MainActor
    static func defaultSessionResolver(_ server: URL) -> AuthSession {
        AuthSession(server: server, client: AuthClient(server: server))
    }

    // NOTE: several `@State` properties below dropped `private` to
    // default-internal so the sibling action extensions
    // (`AppShell+FolderActions.swift` / `+CloudActions.swift` /
    // `+PhotoKitActions.swift`) can read and write them. The widened set
    // is the minimum required by those extensions — properties used only
    // by `body` / layout code stay `private`.
    @State var browseVM = BrowseViewModel()
    @State var sessions: [AssetRef.ID: EditSession] = [:]
    @State private var showExport = false
    @State private var showSettings = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showFilePicker = false

    // Sidebar selection (single active row across the whole tree).
    @State var librarySelection: LibrarySelection = .none

    /// Absolute path inside the currently-open cloud library. Equal to
    /// the library's root path immediately after picking, then bumped
    /// by `navigateFolder` when the user drills into a subfolder. The
    /// sidebar reads this to (a) auto-expand the ancestor chain on
    /// cold start and (b) highlight the matching tree row. Persisted
    /// via `SourceSelection.cloudLibrary` so cold-start restores the
    /// deep path the user left off at.
    @State var cloudCurrentPath: String? = nil

    // Sheet state.
    @State var showSMBSheet = false
    /// Single AddMapleCloudSheet entry point. `nil` means hidden;
    /// `.fresh` means the user clicked "+"; `.prefilled(host)` means
    /// they tapped a saved server without restored tokens. Modeling
    /// presentation + payload as one optional eliminates the "what
    /// was the prefill last time?" hazard from a separate `@State`.
    @State var addCloudSheetTarget: AddCloudSheetTarget?

    // Dynamic toolbar title — reflects the last-loaded source/filter.
    @State var libraryTitle: String = "All"

    // Browse vs Full-image editor mode. Default to browse; a double-click on
    // an image cell flips this to .fullImage. `Mode` is internal (was
    // `private`) so the action extensions can write `mode = .browse` /
    // `mode = .fullImage` after a source load completes.
    enum Mode { case browse, fullImage }
    @State var mode: Mode = .browse

    // BrowseGrid layout — fill (cropped square cover) vs fit (letterboxed).
    // Session-scoped only; no UserDefaults persistence by design (see the
    // toolbar button below).
    @State private var browseDisplayMode: GridDisplayMode = .fill

    #if os(iOS)
    /// Whether the Info detail-panel sheet is up on iPhone. The macOS /
    /// iPad shell shows DetailPanel as a right-hand column in Full-image
    /// mode; iPhone surfaces the same panel via a trailing-toolbar button
    /// → modal sheet so the main content can stay full-width. The button
    /// (and therefore this sheet) is only reachable in Full-image mode —
    /// Browse drops the panel entirely.
    @State private var iPhoneInfoSheet: Bool = false

    /// iPhone drawer snapped state. `dragOffset` (the in-flight finger
    /// translation) lives inside `AppShellIPhoneDrawer` as private
    /// `@State` — only the snapped flag crosses the boundary, since the
    /// hamburger button in `iPhoneMain` writes it directly.
    @State private var isDrawerOpen: Bool = false
    #endif

    /// Set when the user selects a cloud library in Timeline view mode;
    /// when non-nil the center column renders CloudTimelineView instead
    /// of BrowseGrid. Cleared on every other selection so we don't ghost-
    /// render across mode changes.
    @State var cloudTimelineVM: CloudTimelineViewModel?

    /// Thumb client + cache for the active cloud timeline. Constructed
    /// once in `loadCloudLibrary` alongside `cloudTimelineVM` and reused
    /// for the whole lifetime of that VM. Previously these were rebuilt
    /// per render inside the SwiftUI body, which constructed a fresh
    /// `AuthenticatedHTTPClient` actor each time and defeated its
    /// 401-refresh coalescer — under load N parallel cells would each
    /// fire `/api/auth/refresh`, all but one would fail (refresh tokens
    /// are single-use server-side), and the user would get force-signed
    /// out.
    @State var cloudTimelineThumbClient: CloudThumbClient?
    @State var cloudTimelineThumbCache: CloudThumbCache?

    /// Active CloudSource for the merged Photos+Cloud timeline. Non-nil when
    /// a PhotoKit filter is active AND BackupSettings.isConfigured. Cleared
    /// when the user switches to a non-PhotoKit source.
    @State var mergedCloudSource: CloudSource?

    // MARK: - Cloud search

    /// Whether the cloud search UI is showing. When true the center column
    /// renders `CloudSearchView` instead of the grid / timeline. Toggled by
    /// the toolbar magnifying-glass; only meaningful while a cloud library
    /// is selected (see `searchAvailable`).
    @State var isSearchActive = false
    /// Data model for the active search session — constructed by
    /// `activateSearch()`, torn down by `deactivateSearch()`.
    @State var searchVM: SearchViewModel?
    /// Thumb client + cache for search result cells. Built alongside
    /// `searchVM` and reused for the session so the AuthenticatedHTTPClient's
    /// 401-refresh coalescer isn't defeated by per-cell client churn (same
    /// rationale as the timeline thumb client).
    @State var searchThumbClient: CloudThumbClient?
    @State var searchThumbCache: CloudThumbCache?

    /// Search is only available against a Maple Cloud library — local /
    /// PhotoKit / SMB sources have no server-side index to query.
    var searchAvailable: Bool {
        if case .cloudLibrary = librarySelection { return true }
        return false
    }

    // The root bookmark for the currently-open folder tree — used to claim
    // security scope when the user clicks a sub-folder cell inside the grid.
    @State var currentRootBookmark: Data?

    // Active security scope for the current browse session. macOS sandbox
    // requires a scope-backed URL (resolved from a bookmark) to be "accessing"
    // for descendant reads to succeed. Detached render tasks outlive the call
    // that started them, so we hold the scope open for the whole time the
    // library is on this folder. `claimScope(for:)` releases the previous
    // claim and establishes a new one; release happens implicitly when the
    // next claim comes in or when `releaseScope()` is called on app exit.
    @State var activeScopeURL: URL?

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
        .sheet(item: $addCloudSheetTarget) { target in
            AddMapleCloudSheet(
                prefilledDomain: target.prefill,
                onDismiss: { addCloudSheetTarget = nil },
                onSignedIn: { url, tokens, _ in
                    Task { @MainActor in
                        try? TokenStore.save(tokens, server: url)
                        CloudServerRegistry.shared.register(url)
                        // Refresh the per-server AuthSession cache so the
                        // sidebar sees the user as signed in immediately.
                        let session = sessionFor(url)
                        await session.bootstrapAndRestore()
                        addCloudSheetTarget = nil
                    }
                }
            )
        }
        .onChange(of: librarySelection) { _, newValue in
            // Close any active search when the user changes what they're
            // looking at — the search VM is scoped to one library, so it
            // would otherwise show stale results against the new selection.
            // Teardown-only: the new selection's own load repopulates the
            // center column, so we must not also trigger a restore here.
            if isSearchActive { tearDownSearch() }
            // Cloud-current-path + Timeline VM are both only meaningful
            // while a cloud library is selected. Drop both on any
            // non-cloud selection so the sidebar tree's auto-expand /
            // highlight + the center column's Timeline don't ghost
            // across mode changes.
            if case .cloudLibrary = newValue { /* keep */ }
            else {
                cloudCurrentPath = nil
                cloudTimelineVM = nil
                cloudTimelineThumbClient = nil
                cloudTimelineThumbCache = nil
            }
            // Merged timeline only valid while a PhotoKit filter is active.
            if case .photosFilter = newValue { /* keep mergedCloudSource */ }
            else {
                mergedCloudSource = nil
                browseVM.clearMerged()
            }
        }
        .task {
            // UITest harness fast path lives in AppShell+UITestFixture
            // (#if DEBUG). Returns true if a fixture URL was consumed —
            // we then skip restoreLastSource() so the harness gets a
            // known empty starting state.
            #if DEBUG
            if await loadUITestFixtureIfPresent() { return }
            #endif
            // Tear down File Provider domains for servers that are no longer
            // connected. Without this, a server removed in a prior session
            // (or one whose teardown was interrupted) leaves an orphaned
            // domain whose extension keeps polling the gone/rebuilt server —
            // an unrecoverable "bad signature" 401 loop with no UI to clear it.
            await FileProviderDomainController().reconcile(
                validServerURLs: CloudServerRegistry.shared.servers)
            // Restore last-used source on cold start.
            await restoreLastSource()
        }
    }

    // MARK: - Mac / iPad

    @ViewBuilder
    private var macShell: some View {
        AppShellMacLayout(
            isFullImage: mode == .fullImage,
            columnVisibility: $columnVisibility,
            libraryTitle: libraryTitle,
            selectedSession: selectedSession,
            cloudTimelineVM: cloudTimelineVM,
            cloudTimelineThumbClient: cloudTimelineThumbClient,
            cloudTimelineThumbCache: cloudTimelineThumbCache,
            isSearchActive: isSearchActive,
            searchVM: searchVM,
            searchThumbClient: searchThumbClient,
            searchThumbCache: searchThumbCache,
            browseDisplayMode: $browseDisplayMode,
            browseVM: browseVM,
            sessions: $sessions,
            sidebar: { sharedSidebar },
            toolbarContent: { browseToolbarContent },
            onSelectCloudAsset: { asset, server in openCloudAsset(asset, server: server) },
            onCloseSearch: { deactivateSearch() },
            onSelectLocalAsset: { ref in openLocalPhotoKitAsset(ref) },
            onGrantPhotosAccess: { grantPhotosAccessAndLoad() },
            onNavigateFolder: { url in navigateFolder(url) },
            onOpenEditor: { asset in openEditor(for: asset) },
            onPrimeSession: { asset in ensureSession(for: asset) },
            onFullImageFallback: { mode = .browse }
        )
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .frame(minWidth: 520, minHeight: 460)
        }
    }

    /// Shared between the Mac/iPad NavigationSplitView and the iPhone
    /// drawer. Both shells fan the same 13 LibrarySidebar callbacks into
    /// AppShell action methods — keeping this as one computed property
    /// avoids the ~90-LOC duplicate that pre-slice-4 had between
    /// `librarySidebarView` and `iPhoneSidebar`.
    @ViewBuilder
    private var sharedSidebar: some View {
        AppShellSidebar(
            selection: $librarySelection,
            cloudCurrentPath: cloudCurrentPath,
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
            onAddCloudServer: { addCloudSheetTarget = .fresh },
            onPickCloudLibrary: { serverID, folderID, libraryPath in
                loadCloudLibrary(serverID: serverID, folderID: folderID, libraryPath: libraryPath)
            },
            onListCloudDir: { url, absPath in
                await listCloudDirFor(server: url, absPath: absPath)
            },
            onSignOutCloudServer: { url in
                Task { @MainActor in
                    // Sign out keeps the server in the sidebar but
                    // invalidates its tokens. The user can sign back
                    // in by clicking the row (which falls through to
                    // the prefilled AddMapleCloudSheet via the no-
                    // credentials path in loadCloudLibrary).
                    let session = sessionFor(url)
                    await session.signOut()
                }
            },
            onRemoveCloudServer: { url in
                Task { @MainActor in
                    // Remove drops tokens, the registry entry, AND the File
                    // Provider domain. Without the domain teardown the
                    // extension keeps running against a server that's gone
                    // from the UI — it reloads its persisted <host>.json
                    // config and mirrored tokens and polls the (now stale or
                    // rebuilt) server, surfacing as endless "bad signature"
                    // 401 loops with no way to recover from the UI.
                    let session = sessionFor(url)
                    await session.signOut()
                    CloudServerRegistry.shared.remove(url)
                    if let domainID = FileProviderDomainController.domainIdentifier(for: url) {
                        try? await FileProviderDomainController().disable(domainIdentifier: domainID)
                    }
                }
            },
            onLoadCloudFolders: { url in
                await loadCloudFoldersFor(url)
            }
        )
    }

    // MARK: - iPhone

    #if os(iOS)
    /// iPhone shell — overlay drawer wrapping the center column, plus the
    /// Info + Settings sheets. Composed in `AppShellIPhoneShell.swift`
    /// alongside the iPhone-only toolbar items in `AppShellIPhoneToolbar`.
    @ViewBuilder
    private var adaptiveShell: some View {
        AppShellIPhoneShell(
            isDrawerOpen: $isDrawerOpen,
            mode: mode,
            selectedSession: selectedSession,
            libraryTitle: libraryTitle,
            iPhoneInfoSheet: $iPhoneInfoSheet,
            showSettings: $showSettings,
            cloudTimelineVM: cloudTimelineVM,
            cloudTimelineThumbClient: cloudTimelineThumbClient,
            cloudTimelineThumbCache: cloudTimelineThumbCache,
            isSearchActive: isSearchActive,
            searchVM: searchVM,
            searchThumbClient: searchThumbClient,
            searchThumbCache: searchThumbCache,
            browseDisplayMode: $browseDisplayMode,
            browseVM: browseVM,
            sessions: $sessions,
            sidebar: { sharedSidebar },
            toolbarContent: { browseToolbarContent },
            onSelectCloudAsset: { asset, server in openCloudAsset(asset, server: server) },
            onCloseSearch: { deactivateSearch() },
            onSelectLocalAsset: { ref in openLocalPhotoKitAsset(ref) },
            onGrantPhotosAccess: { grantPhotosAccessAndLoad() },
            onNavigateFolder: { url in navigateFolder(url) },
            onOpenEditor: { asset in openEditor(for: asset) },
            onPrimeSession: { asset in ensureSession(for: asset) },
            onFullImageFallback: { mode = .browse }
        )
    }
    #endif

    // MARK: - Toolbar

    /// Wires `AppShell` state into `AppShellToolbar` (defined in
    /// `AppShellToolbar.swift`). Kept as a small computed property so each
    /// call site can write `.toolbar { browseToolbarContent }` without
    /// repeating the parameter list.
    @ToolbarContentBuilder
    private var browseToolbarContent: some ToolbarContent {
        AppShellToolbar(
            isFullImage: mode == .fullImage,
            hasSelection: selectedSession != nil,
            searchAvailable: searchAvailable,
            isSearchActive: isSearchActive,
            browseDisplayMode: $browseDisplayMode,
            onBack: { mode = .browse },
            onToggleSearch: { toggleSearch() },
            onExport: { showExport = true },
            onOpenFolder: { showFilePicker = true },
            onSettings: { showSettings = true }
        )
    }
}

// MARK: - Previews
//
// Issue #139 — root composition view. The default initialiser supplies
// a no-op session resolver that constructs preview AuthSessions on
// demand; the empty BrowseViewModel state drives the no-source layout.
// The full three-column split is the load-bearing case to surface.

#Preview("Default") {
    AppShell(sessionFor: { server in
        AuthSession.preview(state: .signedOut, server: server)
    })
    .frame(width: 1100, height: 720)
}
