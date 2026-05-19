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
import OSLog
import MapleCore
#if os(iOS)
import UIKit
#endif

private let cloudHTTPLogger = Logger(subsystem: "app.justmaple.aperture", category: "Cloud.HTTP")
private let fileProviderLogger = Logger(subsystem: "app.justmaple.aperture", category: "FileProvider")

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

    @State private var browseVM = BrowseViewModel()
    @State private var sessions: [AssetRef.ID: EditSession] = [:]
    @State private var showExport = false
    @State private var showSettings = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showFilePicker = false

    // Sidebar selection (single active row across the whole tree).
    @State private var librarySelection: LibrarySelection = .none

    /// Absolute path inside the currently-open cloud library. Equal to
    /// the library's root path immediately after picking, then bumped
    /// by `navigateFolder` when the user drills into a subfolder. The
    /// sidebar reads this to (a) auto-expand the ancestor chain on
    /// cold start and (b) highlight the matching tree row. Persisted
    /// via `SourceSelection.cloudLibrary` so cold-start restores the
    /// deep path the user left off at.
    @State private var cloudCurrentPath: String? = nil

    // Sheet state.
    @State private var showSMBSheet = false
    /// Single AddMapleCloudSheet entry point. `nil` means hidden;
    /// `.fresh` means the user clicked "+"; `.prefilled(host)` means
    /// they tapped a saved server without restored tokens. Modeling
    /// presentation + payload as one optional eliminates the "what
    /// was the prefill last time?" hazard from a separate `@State`.
    @State private var addCloudSheetTarget: AddCloudSheetTarget?

    // Dynamic toolbar title — reflects the last-loaded source/filter.
    @State private var libraryTitle: String = "All"

    // Browse vs Full-image editor mode. Default to browse; a double-click on
    // an image cell flips this to .fullImage.
    private enum Mode { case browse, fullImage }
    @State private var mode: Mode = .browse

    // BrowseGrid layout — fill (cropped square cover) vs fit (letterboxed).
    // Session-scoped only; no UserDefaults persistence by design (see the
    // toolbar button below).
    @State private var browseDisplayMode: GridDisplayMode = .fill

    #if os(iOS)
    /// Whether the Info detail-panel sheet is up on iPhone. The macOS /
    /// iPad shell shows DetailPanel as a permanent right-hand column;
    /// iPhone surfaces the same panel via a trailing-toolbar button
    /// → modal sheet so the main content can stay full-width.
    @State private var iPhoneInfoSheet: Bool = false

    /// iPhone drawer state — Notion-Mail-style left-side overlay menu.
    /// `isDrawerOpen` is the snapped state (open / closed); `dragOffset`
    /// is the in-flight finger translation that lets the drawer track
    /// the user's finger during a swipe. We snap on gesture-end based
    /// on translation distance OR velocity (whichever fires first), so
    /// fast flicks open/close even with small visible travel.
    @State private var isDrawerOpen: Bool = false
    @State private var dragOffset: CGFloat = 0

    /// Honor the user's reduce-motion preference — swap the spring
    /// slide for an instant snap when the system is set to that mode.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Drawer geometry. 280pt is wide enough to fit the longest folder
    /// names in the LibrarySidebar tree without truncation, narrow
    /// enough that ~70pt of the underlying browse grid still peeks
    /// through on a 6.1" iPhone.
    private static let drawerWidth: CGFloat = 280
    /// Left-edge horizontal slab where the open-drawer drag gesture
    /// activates. 20pt matches Apple's NavigationStack swipe-back zone.
    private static let edgeActivationZone: CGFloat = 20
    #endif

    /// Set when the user selects a cloud library in Timeline view mode;
    /// when non-nil the center column renders CloudTimelineView instead
    /// of BrowseGrid. Cleared on every other selection so we don't ghost-
    /// render across mode changes.
    @State private var cloudTimelineVM: CloudTimelineViewModel?

    /// Thumb client + cache for the active cloud timeline. Constructed
    /// once in `loadCloudLibrary` alongside `cloudTimelineVM` and reused
    /// for the whole lifetime of that VM. Previously these were rebuilt
    /// per render inside the SwiftUI body, which constructed a fresh
    /// `AuthenticatedHTTPClient` actor each time and defeated its
    /// 401-refresh coalescer — under load N parallel cells would each
    /// fire `/api/auth/refresh`, all but one would fail (refresh tokens
    /// are single-use server-side), and the user would get force-signed
    /// out.
    @State private var cloudTimelineThumbClient: CloudThumbClient?
    @State private var cloudTimelineThumbCache: CloudThumbCache?

    /// Active CloudSource for the merged Photos+Cloud timeline. Non-nil when
    /// a PhotoKit filter is active AND BackupSettings.isConfigured. Cleared
    /// when the user switches to a non-PhotoKit source.
    @State private var mergedCloudSource: CloudSource?

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
                onAddCloudServer: {
                    addCloudSheetTarget = .fresh
                },
                onPickCloudLibrary: { serverID, folderID, libraryPath in
                    loadCloudLibrary(serverID: serverID, folderID: folderID, libraryPath: libraryPath)
                },
                onListCloudDir: { url, absPath in
                    await listCloudDirFor(server: url, absPath: absPath)
                },
                cloudCurrentPath: cloudCurrentPath,
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
                        // Remove drops tokens AND the registry entry.
                        let session = sessionFor(url)
                        await session.signOut()
                        CloudServerRegistry.shared.remove(url)
                    }
                },
                onLoadCloudFolders: { url in
                    await loadCloudFoldersFor(url)
                }
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
                    if let vm = cloudTimelineVM,
                       let thumbClient = cloudTimelineThumbClient,
                       let thumbCache = cloudTimelineThumbCache {
                        CloudTimelineView(
                            vm: vm,
                            thumbClient: thumbClient,
                            thumbCache: thumbCache,
                            displayMode: browseDisplayMode,
                            onSelectAsset: { asset in openCloudAsset(asset, server: vm.server) },
                            onSelectLocalAsset: { ref in openLocalPhotoKitAsset(ref) }
                        )
                    } else {
                        BrowseGrid(
                            vm: browseVM,
                            sessions: $sessions,
                            displayMode: $browseDisplayMode,
                            onGrantPhotosAccess: { grantPhotosAccessAndLoad() },
                            onNavigateFolder: { url in navigateFolder(url) },
                            onOpenEditor: { asset in openEditor(for: asset) },
                            onPrimeSession: { asset in ensureSession(for: asset) }
                        )
                    }
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
            // `isFullImage` drives Ticket 12 bugs 4/5/8: the panel auto-flips
            // to Develop on entry, back to Info on exit, and hides the
            // Develop segment entirely while the user is in Browse mode.
            // Width: iPad expands the column toward `max` (~half the screen
            // when balanced), so DetailPanelWidth tightens the range there
            // to just fit the slider rail. macOS keeps the original range.
            DetailPanel(session: selectedSession, isFullImage: mode == .fullImage)
                .modifier(DetailPanelWidth())
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .frame(minWidth: 520, minHeight: 460)
        }
    }

    // MARK: - iPhone (compact ZStack drawer)

    #if os(iOS)
    /// iPhone shell. Browse is the base layer; the LibrarySidebar slides
    /// in from the left as an overlay drawer (Notion-Mail-style),
    /// summoned via the leading hamburger button OR a left-edge swipe.
    /// Dismiss via tap-outside (dim overlay), drag-back, or selecting a
    /// row. Info detail still uses .sheet with detents — same as before.
    /// Edit is a mode swap (FullImageView replaces BrowseGrid in the
    /// base layer); the drawer is unreachable from the viewer (open
    /// question 5 in the design doc) so gestures stay unambiguous.
    private var adaptiveShell: some View {
        GeometryReader { _ in
            ZStack(alignment: .leading) {
                // Base — the actual content of the app. Wrapped in a
                // NavigationStack so navigationTitle + toolbar work.
                NavigationStack {
                    iPhoneMain
                }
                .accentColor(MapleTokens.primary)
                // Block taps to the base when the drawer is open so a
                // mis-aimed tap behind the drawer doesn't trigger
                // background actions.
                .disabled(isDrawerOpen)

                // Dim overlay — fades in proportional to drawer
                // position. Tap to close. Hidden when drawer is closed
                // so it doesn't intercept taps on the base layer.
                if drawerProgress > 0.001 {
                    Color.black
                        .opacity(0.45 * drawerProgress)
                        .ignoresSafeArea()
                        .onTapGesture { closeDrawer() }
                        .accessibilityHidden(true)
                }

                // The drawer itself. LibrarySidebar paints its own
                // bg (MapleTokens.sidebar), so no extra background
                // needed here.
                iPhoneSidebar
                    .frame(width: AppShell.drawerWidth)
                    .frame(maxHeight: .infinity)
                    .offset(x: drawerXOffset)
                    .gesture(drawerCloseDragGesture)
            }
            // Edge-swipe to open. Only fires from the leftmost 20pt
            // and only when the drawer is closed AND we're in browse
            // mode — keeps gestures unambiguous w.r.t. the viewer's
            // own swipe handling.
            //
            // `.simultaneousGesture` (NOT `.gesture`) so the recognizer
            // doesn't pre-empt normal horizontal scrolls in child
            // views (the grid, the FullImage filmstrip) when the drag
            // starts outside the edge zone. The gesture's onChanged /
            // onEnded already short-circuit when the start location is
            // past `edgeActivationZone`, so attaching simultaneously
            // means rejected drags fall through to whichever child
            // gesture wants them.
            .simultaneousGesture(edgeOpenDragGesture)
        }
        .ignoresSafeArea(.keyboard)
        .sheet(isPresented: $iPhoneInfoSheet) {
            NavigationStack {
                DetailPanel(session: selectedSession, isFullImage: mode == .fullImage)
                    .navigationTitle("Info")
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { iPhoneInfoSheet = false }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .presentationDetents([.large])
        }
    }

    // MARK: drawer math

    /// X-translation applied to the drawer view. 0 = fully visible
    /// against the left edge; -drawerWidth = fully off-screen. The
    /// in-flight `dragOffset` is added on top of the snapped state,
    /// clamped so the user can't drag past either end.
    private var drawerXOffset: CGFloat {
        if isDrawerOpen {
            // Open — only allow leftward drag (negative). Right-drag
            // is a no-op since the drawer is already fully visible.
            return min(0, dragOffset)
        } else {
            // Closed — only allow rightward drag (positive), capped at
            // drawerWidth so the open animation doesn't overshoot.
            return -AppShell.drawerWidth + max(0, min(AppShell.drawerWidth, dragOffset))
        }
    }

    /// 0 when the drawer is fully off-screen, 1 when fully visible.
    /// Drives the dim-overlay opacity so the dim fades in/out smoothly
    /// alongside the slide.
    private var drawerProgress: CGFloat {
        let visible = AppShell.drawerWidth + drawerXOffset
        return max(0, min(1, visible / AppShell.drawerWidth))
    }

    // MARK: drawer gestures

    /// Drag gesture on the drawer itself — used to drag the open
    /// drawer back closed. Snaps closed if translation crosses 1/3
    /// width OR velocity goes leftward fast (>300pt/s).
    private var drawerCloseDragGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                guard isDrawerOpen else { return }
                dragOffset = value.translation.width
            }
            .onEnded { value in
                guard isDrawerOpen else {
                    snapDragOffset()
                    return
                }
                let translation = value.translation.width
                let velocity = value.predictedEndTranslation.width
                if translation < -AppShell.drawerWidth / 3 || velocity < -200 {
                    closeDrawer()
                } else {
                    snapDragOffset()
                }
            }
    }

    /// Drag gesture on the root ZStack — opens the drawer when the
    /// user starts dragging from the left edge. Confined to the leftmost
    /// `edgeActivationZone` AND to browse mode so we don't conflict
    /// with the viewer's own gestures or the grid's horizontal scroll.
    private var edgeOpenDragGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard !isDrawerOpen,
                      mode == .browse,
                      value.startLocation.x < AppShell.edgeActivationZone else { return }
                dragOffset = max(0, value.translation.width)
            }
            .onEnded { value in
                guard !isDrawerOpen,
                      mode == .browse,
                      value.startLocation.x < AppShell.edgeActivationZone else {
                    snapDragOffset()
                    return
                }
                let translation = value.translation.width
                let velocity = value.predictedEndTranslation.width
                if translation > AppShell.drawerWidth / 3 || velocity > 200 {
                    openDrawer()
                } else {
                    snapDragOffset()
                }
            }
    }

    // MARK: drawer actions

    private func openDrawer() {
        runAnimated {
            isDrawerOpen = true
            dragOffset = 0
        }
    }

    private func closeDrawer() {
        runAnimated {
            isDrawerOpen = false
            dragOffset = 0
        }
    }

    /// Used after a drag-end that didn't cross the snap threshold —
    /// returns the drawer to its pre-drag snapped state.
    private func snapDragOffset() {
        runAnimated { dragOffset = 0 }
    }

    /// Runs the closure inside a spring animation, OR instantly if the
    /// user has reduce-motion enabled. The spring matches the timing
    /// the design doc calls out (response 0.3 / damping 0.85).
    private func runAnimated(_ work: () -> Void) {
        if reduceMotion {
            work()
        } else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.85), work)
        }
    }

    @ViewBuilder
    private var iPhoneSidebar: some View {
        // Drawer-stay-open by design: the user wants to drill down a
        // cloud folder tree and toggle expand/collapse without the
        // drawer collapsing on every selection. Selection still updates
        // the underlying browse grid; the user closes the drawer
        // manually via tap-on-dim or drag-back when ready to look at it.
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
            onAddCloudServer: { addCloudSheetTarget = .fresh },
            onPickCloudLibrary: { serverID, folderID, libraryPath in
                loadCloudLibrary(serverID: serverID, folderID: folderID, libraryPath: libraryPath)
            },
            onListCloudDir: { url, absPath in
                await listCloudDirFor(server: url, absPath: absPath)
            },
            cloudCurrentPath: cloudCurrentPath,
            onSignOutCloudServer: { url in
                Task { @MainActor in
                    let session = sessionFor(url)
                    await session.signOut()
                }
            },
            onRemoveCloudServer: { url in
                Task { @MainActor in
                    let session = sessionFor(url)
                    await session.signOut()
                    CloudServerRegistry.shared.remove(url)
                }
            },
            onLoadCloudFolders: { url in
                await loadCloudFoldersFor(url)
            }
        )
    }

    @ViewBuilder
    private var iPhoneMain: some View {
        Group {
            switch mode {
            case .browse:
                if let vm = cloudTimelineVM,
                   let thumbClient = cloudTimelineThumbClient,
                   let thumbCache = cloudTimelineThumbCache {
                    CloudTimelineView(
                        vm: vm,
                        thumbClient: thumbClient,
                        thumbCache: thumbCache,
                        displayMode: browseDisplayMode,
                        onSelectAsset: { asset in openCloudAsset(asset, server: vm.server) },
                        onSelectLocalAsset: { ref in openLocalPhotoKitAsset(ref) }
                    )
                } else {
                    BrowseGrid(
                        vm: browseVM,
                        sessions: $sessions,
                        displayMode: $browseDisplayMode,
                        onGrantPhotosAccess: { grantPhotosAccessAndLoad() },
                        onNavigateFolder: { url in navigateFolder(url) },
                        onOpenEditor: { asset in openEditor(for: asset) },
                        onPrimeSession: { asset in ensureSession(for: asset) }
                    )
                }
            case .fullImage:
                if let session = selectedSession {
                    FullImageView(session: session)
                } else {
                    Color.clear.onAppear { mode = .browse }
                }
            }
        }
        .navigationTitle(mode == .fullImage
                         ? (selectedSession?.asset.displayName ?? "Image")
                         : libraryTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Hamburger only meaningful in browse mode (per open
            // question 5: drawer unreachable from viewer).
            if mode == .browse {
                ToolbarItem(placement: .topBarLeading) {
                    Button { openDrawer() } label: {
                        Image(systemName: "line.3.horizontal")
                            .font(.system(size: 17, weight: .semibold))
                    }
                    .accessibilityLabel("Library")
                }
            }
            browseToolbar
            ToolbarItem(placement: .topBarTrailing) {
                Button { iPhoneInfoSheet = true } label: {
                    Image(systemName: "info.circle")
                }
                .accessibilityLabel("Info")
            }
            // Settings gear is provided by `browseToolbar` — don't duplicate
            // it here, or two buttons share the same accessibilityIdentifier
            // and UI-test lookups become ambiguous.
        }
    }
    #endif

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var browseToolbar: some ToolbarContent {
        // Toolbar items at `.navigation` placement land on the LEADING edge
        // of the title bar — right of the sidebar-toggle button, left of
        // the navigationTitle. When the sidebar is closed the placement
        // collapses to "right after the menu/sidebar button, before the
        // image name." Per UX request: back/share/zoom controls live in
        // the header next to the menu button rather than at the trailing
        // edge after the title.
        ToolbarItem(placement: .navigation) {
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
        // Grid fill/fit toggle — only relevant in browse mode. Persists for
        // the session via @State on AppShell. The button shows the OPPOSITE
        // icon as the action target (see `GridDisplayMode.toggleIconName`).
        // Placement .navigation per the same UX rule as the rest of
        // browseToolbar — header controls cluster on the leading edge,
        // right of the sidebar-toggle button.
        if mode == .browse {
            ToolbarItem(placement: .navigation) {
                Button {
                    browseDisplayMode = browseDisplayMode.toggled
                } label: {
                    Image(systemName: browseDisplayMode.toggleIconName)
                        .foregroundStyle(MapleTokens.textMuted)
                }
                .accessibilityLabel(browseDisplayMode.toggleAccessibilityLabel)
                .accessibilityIdentifier("browse-grid-display-mode-toggle")
            }
        }
        ToolbarItem(placement: .navigation) {
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
        ToolbarItem(placement: .automatic) {
            Button("Settings", systemImage: "gear") {
                showSettings = true
            }
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("settings-button")
            #if os(macOS)
            .keyboardShortcut(",", modifiers: .command)
            #endif
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
    private func loadFolder(url: URL, isFPRouted: Bool = false) {
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
        //
        // Also satisfies the FP-routing contract: `FileProviderMountRouter`
        // hands back a scope-backed bookmark URL and documents that the
        // caller must claim scope — `claimScope(for:)` here is that claim,
        // so the FP call site doesn't need to do it separately.
        claimScope(for: url)

        // `url` here came from `.fileImporter` which returns a scope-backed
        // URL — propagate it to the VM so each synthesised AssetRef carries
        // the scope reference through to the pipeline / loader.
        browseVM.currentScopeRoot = url
        browseVM.loadFolder(url: url)
        // FP-routed callers keep their own `librarySelection` (the cloud
        // server row in the sidebar) and own their title — see the FP
        // branch in `loadCloudLibrary`. Overwriting either here would
        // ghost-highlight "Local folders" while the user is reading the
        // FP-mounted cloud library, and would clobber the cloud server
        // hostname in the title bar.
        if !isFPRouted {
            librarySelection = .folder(path: url.path)
            libraryTitle = url.lastPathComponent
        }
        mode = .browse

        for asset in browseVM.assets where sessions[asset.id] == nil {
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            Task { await session.loadSidecar() }
        }
        // FP-routed callers MUST NOT mint a new filesystem bookmark or
        // persist a `.filesystem` SourceSelection / SavedFolder entry: the
        // server's identity stays `cloudLibrary(serverID:…)` so cold start
        // re-enters `loadCloudLibrary` (which re-runs the FP-routing
        // decision). Recording the FP mount path under "Local folders"
        // would also leave a dangling stale-bookmark entry if the user
        // later disables sync for that server — the bookmark target
        // disappears with the FP domain.
        if isFPRouted { return }
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
        // Issue #101 (continued): FP-routed cloud libraries — when the
        // active library is a cloud server AND we have a usable FP-mount
        // bookmark for it, the subfolder URL the grid hands us is already
        // a real filesystem URL under the FP mount (FilesystemSource
        // produced it). Drive through `browseVM.loadFolder(url:)` exactly
        // like the top-level FP open, and keep `librarySelection` /
        // `currentRootBookmark` unchanged.
        //
        // This branch MUST come before the `.cloudLibrary + CloudSource`
        // branch below — otherwise a stale `CloudSource` left over from
        // a previous API-routed visit in the same session would silently
        // re-route this drill-down through `/api/fs/dir`, defeating the
        // whole point of FP routing.
        if case .cloudLibrary(let serverID, _) = librarySelection,
           case .folderView = FileProviderMountRouter.resolve(serverURL: serverID) {
            Task.detached { await ThumbnailLoader.shared.cancelAll() }
            Task.detached {
                await ThumbnailDiskCache.shared.configure(folderURL: url)
                await RenderedPreviewCache.shared.configure(folderURL: url)
                await DecodedBufferCache.shared.configure(folderURL: url)
            }
            claimScope(for: url)
            browseVM.currentScopeRoot = url
            browseVM.loadFolder(url: url)
            libraryTitle = url.lastPathComponent
            return
        }

        // Cloud-library context: drill into the subfolder via /api/fs/dir
        // instead of the filesystem-bookmark path. URL.path carries the
        // server-side absolute path. We don't update LibrarySelection
        // because the drilled-in path is browser state, not a sidebar
        // selection — the user is still on the same library row.
        if case .cloudLibrary(let serverID, let folderID) = librarySelection,
           let source = browseVM.currentSource as? CloudSource {
            cloudCurrentPath = url.path
            // Persist the drilled-in path so cold start restores at the
            // current depth (and the sidebar auto-expands the ancestor
            // chain to match).
            SourceSelectionStore.save(.cloudLibrary(serverID: serverID,
                                                    folderID: folderID,
                                                    libraryPath: url.path))
            Task { @MainActor in
                await browseVM.loadCloudDir(source, absPath: url.path)
                libraryTitle = url.lastPathComponent
            }
            return
        }

        guard let bookmark = currentRootBookmark else {
            // Fall back to a plain loadFolder — works for folders inside the
            // user's security-scope, fails silently for sandboxed reads.
            // Keep whatever scope root is already active.
            Task.detached { await ThumbnailLoader.shared.cancelAll() }
            browseVM.loadFolder(url: url)
            librarySelection = .folder(path: url.path)
            libraryTitle = url.lastPathComponent
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
        // Clear the prior source's assets immediately so the user sees the
        // grid flip to "Loading…" the moment they click a Photos filter,
        // instead of staring at the previous folder's tiles while the
        // PhotoKit fetch + enumeration runs in the background. Without this,
        // a user clicking "All Photos" from a populated filesystem folder
        // perceives the click as having done nothing for several seconds —
        // particularly painful on libraries large enough to make
        // `images()` enumeration take noticeable wall time.
        browseVM.beginLoadingPhotosFilter()
        Task { @MainActor in
            do {
                let source = try PhotoKitSource()
                try await source.fetchAssets(for: filter)
                // PhotoKit-library view is always single-source. The merged
                // Photos+Cloud view belongs on the cloud-library timeline
                // (where the user is browsing the backup destination), not
                // here. Keep mergedCloudSource nil for consistency.
                mergedCloudSource = nil
                await browseVM.loadSource(source)
                SourceSelectionStore.save(.photoKitFilter(filter))
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

    // MARK: - Maple Cloud

    @MainActor
    private func makeAuthenticatedHTTPClient(server: URL) -> AuthenticatedHTTPClient {
        AuthenticatedHTTPClient(
            server: server,
            urlSession: .shared,
            tokensProvider: { try? TokenStore.load(server: server) },
            onTokensRefreshed: { try? TokenStore.save($0, server: server) },
            onSignOut: { TokenStore.clear(server: server) }
        )
    }

    @MainActor
    private func loadCloudFoldersFor(_ url: URL) async -> [CloudFolder] {
        // The sidebar's CloudServerSection .task fires at app launch in
        // parallel with restoreLastSource → bootstrapAndRestore. Without
        // the same await dance autoPickInitialSource / loadCloudLibrary
        // do, the /api/folders request races out before tokens are
        // restored — server replies 401 "missing bearer", the
        // AuthenticatedHTTPClient's refresh path also finds no tokens
        // (race), and we silently return []. Awaiting bootstrap here
        // ensures the keychain restore is complete before tokensProvider
        // is consulted.
        let session = sessionFor(url)
        if !session.isSignedIn { await session.bootstrapAndRestore() }
        guard session.isSignedIn else { return [] }

        let httpClient = makeAuthenticatedHTTPClient(server: url)
        let client = CloudFoldersClient(server: url, httpClient: httpClient)
        do {
            let folders = try await client.listFolders()
            CloudFoldersCache.save(folders, server: url)
            return folders
        }
        catch {
            // Offline / server hiccup — fall back to the last-known
            // folder list so the sidebar still has something to render.
            // Returning [] here used to give the user an empty sidebar
            // every time the network blipped.
            //
            // Log the swallowed error so triage can distinguish "live
            // request failed; served cached data" from "live request
            // succeeded but returned no folders" — invisible before.
            let cached = CloudFoldersCache.load(server: url)
            cloudHTTPLogger.info(
              "listFolders failed for \(url.absoluteString, privacy: .public): \(error.localizedDescription, privacy: .public) — fallback: \(cached != nil ? "cache (\(cached!.count) folders)" : "empty", privacy: .public)"
            )
            return cached ?? []
        }
    }

    @MainActor
    private func listCloudDirFor(server: URL, absPath: String) async -> FsDirListing? {
        // Same cold-start race as loadCloudFoldersFor — wait for
        // bootstrap before calling /api/fs/dir so the request actually
        // carries a bearer token. Sidebar tree-row expansion can fire
        // this before AuthSession.user is hydrated from Keychain.
        let session = sessionFor(server)
        if !session.isSignedIn { await session.bootstrapAndRestore() }
        guard session.isSignedIn else { return nil }

        let httpClient = makeAuthenticatedHTTPClient(server: server)
        let client = CloudFoldersClient(server: server, httpClient: httpClient)
        do { return try await client.listDir(absPath: absPath) }
        catch { return nil }
    }

    /// Cold-start fallback when there's no saved selection. Picks the
    /// first sensible source so the user lands on something instead of
    /// staring at "Pick a folder in the sidebar." Priority:
    /// 1. First registered cloud server's first library
    /// 2. Most-recent local folder from SavedFolderStore
    /// PhotoKit is intentionally NOT auto-picked — it's permission-
    /// gated and ambushy.
    @MainActor
    private func autoPickInitialSource() async {
        for serverURL in CloudServerRegistry.shared.servers {
            let session = sessionFor(serverURL)
            if !session.isSignedIn { await session.bootstrapAndRestore() }
            guard session.isSignedIn else { continue }
            let libs = await loadCloudFoldersFor(serverURL)
            if let first = libs.first {
                loadCloudLibrary(serverID: serverURL,
                                 folderID: first.id,
                                 libraryPath: first.path)
                return
            }
        }
        if let first = SavedFolderStore.load().first {
            openSavedFolder(first)
            return
        }
    }

    @MainActor
    private func loadCloudLibrary(serverID: URL, folderID: String, libraryPath: String) {
        librarySelection = .cloudLibrary(serverID: serverID, folderID: folderID)
        cloudCurrentPath = libraryPath
        SourceSelectionStore.save(.cloudLibrary(serverID: serverID, folderID: folderID, libraryPath: libraryPath))
        currentRootBookmark = nil

        Task { @MainActor in
            let session = sessionFor(serverID)
            // On cold start, sessionFor() returns a freshly-constructed
            // session whose Keychain restore is still in flight. Awaiting
            // bootstrapAndRestore() before checking isSignedIn lets that
            // restore finish — otherwise we'd always fall through to the
            // sign-in sheet on first launch even though tokens exist.
            //
            // For sessions that are already signed in (warm cache, sidebar
            // click during the session), isSignedIn short-circuits and the
            // await is skipped.
            //
            // For sessions where signOut() was called or refresh failed,
            // bootstrapAndRestore() returns without setting user, isSignedIn
            // stays false, and we route to the prefilled sign-in sheet —
            // same as the previous synchronous behavior.
            if !session.isSignedIn {
                await session.bootstrapAndRestore()
            }
            guard session.isSignedIn else {
                addCloudSheetTarget = .prefilled(serverID.host ?? serverID.absoluteString)
                return
            }

            // Issue #101: when the user has granted the app a bookmark to
            // the FP-mounted folder for this server, route reads/writes
            // through the existing Folder-View code path against that
            // mount instead of the API. The FP extension is doing the
            // server I/O on demand — the app stays out of the loop.
            //
            // Stale bookmark / scope-denied: fall back to the API path
            // (don't silently fail). The Settings UI surfaces "Sync
            // access lost" via `FileProviderMountRouter.isBookmarkBroken`
            // on next open.
            if case .folderView(let mountURL) = FileProviderMountRouter.resolve(serverURL: serverID) {
                cloudTimelineVM = nil
                // Reuses the local folder-picker entry point — listing,
                // thumbnails, XMP read/write, and the edit pipeline all
                // flow through unchanged; the FP extension does the
                // server I/O on demand.
                //
                // `isFPRouted: true` opts out of the persistence tail:
                //   - no FilesystemSource bookmark mint over the FP mount
                //   - no `.filesystem(bookmark:)` SourceSelection save
                //     (we keep the `.cloudLibrary(...)` one persisted
                //     just above, so cold start re-enters this method
                //     and re-runs the FP-routing decision)
                //   - no SavedFolderStore entry for ~/Library/CloudStorage/…
                //     in the user's "Local folders" sidebar
                //   - librarySelection stays `.cloudLibrary(...)` so the
                //     sidebar highlights the cloud server row, not Local
                //     folders. XMP writes still route through
                //     XMPSidecarStore because EditSession picks its
                //     sidecar path from the asset's primaryURL — the
                //     FilesystemSource-synthesized AssetRefs carry no
                //     stableID, so `ensureSession` cannot construct a
                //     CloudSidecarStore for them either.
                libraryTitle = serverID.host ?? serverID.absoluteString
                loadFolder(url: mountURL, isFPRouted: true)
                fileProviderLogger.notice("FP mount routing: \(serverID.absoluteString, privacy: .public) → folder view at \(mountURL.path, privacy: .public)")
                return
            }

            let viewMode = CloudServerRegistry.shared.viewMode(for: serverID)
            switch viewMode {
            case .folder:
                cloudTimelineVM = nil
                let httpClient = makeAuthenticatedHTTPClient(server: serverID)
                let source = CloudSource(server: serverID,
                                         folderID: folderID,
                                         libraryPath: libraryPath,
                                         httpClient: httpClient)
                // Use the dir-listing loader so the grid shows BOTH
                // subfolders and images at this level.
                await browseVM.loadCloudDir(source, absPath: libraryPath)

                // Path-not-on-server fallback. If the persisted path
                // was renamed or deleted server-side, /api/fs/dir 4xx's
                // and BrowseViewModel.loadError gets set. Look up the
                // library's registered root via /api/folders and retry
                // there, then update the persisted selection so cold
                // start no longer points at the missing path.
                if browseVM.loadError != nil {
                    let foldersClient = CloudFoldersClient(server: serverID,
                                                           httpClient: httpClient)
                    if let libs = try? await foldersClient.listFolders(),
                       let registered = libs.first(where: { $0.id == folderID }),
                       registered.path != libraryPath {
                        // The original 4xx is already logged by CloudSource's
                        // decode-error path; no need for an extra line here.
                        cloudCurrentPath = registered.path
                        SourceSelectionStore.save(.cloudLibrary(serverID: serverID,
                                                                folderID: folderID,
                                                                libraryPath: registered.path))
                        await browseVM.loadCloudDir(source, absPath: registered.path)
                    }
                }

                libraryTitle = serverID.host ?? serverID.absoluteString
                mode = .browse
            case .timeline:
                browseVM.clear()
                // Single AuthenticatedHTTPClient shared by the search +
                // thumb clients for the lifetime of this Timeline VM.
                // Defeats the 401-refresh-storm bug if many cells hit
                // expired tokens at once — only one /api/auth/refresh
                // call goes out, all callers wait on the same continuation.
                let httpClient = makeAuthenticatedHTTPClient(server: serverID)
                let searchClient = CloudSearchClient(server: serverID, httpClient: httpClient)
                // pathPrefix = libraryPath scopes the Timeline to whatever
                // the user has selected in the sidebar tree — library root
                // when they pick the library row, a subfolder when they
                // pick deeper. Matches the web Timeline's filter behavior:
                // both /api/search/buckets and /api/search receive the
                // same pathPrefix so the bucket counts and asset listings
                // describe the same scope.
                // Construct a PhotoKitMergeAdapter when this cloud library is
                // the configured backup destination AND the user has granted
                // PhotoKit access. This enables the merged Photos+Cloud view
                // so the user sees local-only, synced, and cloud-only cells
                // with sync-status badges.
                let photoKitMerge: PhotoKitMergeAdapter? = {
                    guard let settings = BackupSettings.load(),
                          settings.isConfigured,
                          settings.serverURL == serverID.absoluteString,
                          settings.libraryId == folderID else { return nil }
                    let status = PhotoKitLibrary.authorizationStatus()
                    guard status == .authorized || status == .limited else { return nil }
                    let adapter = PhotoKitMergeAdapter()
                    // Kick a background warm-up so the cache refreshes against
                    // current PhotoKit state. The adapter's init already loaded
                    // any disk-cached buckets synchronously, so first-paint of
                    // the cloud timeline is instant on subsequent launches.
                    // First-ever launch sees cloud-only cells until warm-up
                    // finishes; the VM observes `onWarmedUp` to re-merge.
                    Task { await adapter.warmUp() }
                    return adapter
                }()
                cloudTimelineVM = CloudTimelineViewModel(
                    server: serverID,
                    libraryID: folderID,
                    pathPrefix: libraryPath,
                    searchClient: searchClient,
                    photoKitMerge: photoKitMerge)
                cloudTimelineThumbClient = CloudThumbClient(server: serverID, httpClient: httpClient)
                cloudTimelineThumbCache = CloudThumbCache()
                libraryTitle = (serverID.host ?? serverID.absoluteString) + " — Timeline"
                mode = .browse
            }
        }
    }

    /// Open the FullImage editor for a `.localOnly` cell selected from the
    /// merged cloud timeline. These are PhotoKit photos that haven't been
    /// uploaded yet, so there is no `SearchAsset` to route through
    /// `openCloudAsset` — instead, build a PhotoKit-backed AssetRef from
    /// the asset's local identifier and open it in the editor with
    /// session-local edits (matches the regular PhotoKit-filter flow).
    @MainActor
    private func openLocalPhotoKitAsset(_ ref: ImageRef) {
        Task { @MainActor in
            do {
                let source = try PhotoKitSource()
                let displayName = ref.displayName
                let ext = (displayName as NSString).pathExtension.lowercased()
                let assetRef = AssetRef(
                    displayName: displayName,
                    hintExtension: ext.isEmpty ? nil : ext,
                    stableID: ref.id,
                    bytesProvider: { [source, ref] in
                        try await source.rawBytes(for: ref)
                    }
                )
                if sessions[assetRef.id] == nil {
                    let session = EditSession(asset: assetRef)
                    sessions[assetRef.id] = session
                    Task { await session.loadSidecar() }
                }
                browseVM.loadSingleCloudAsset(assetRef)
                mode = .fullImage
            } catch {
                browseVM.loadError = error
            }
        }
    }

    /// Open the FullImage editor for a cloud asset selected from
    /// CloudTimelineView. Builds a bytes-providing AssetRef so the Rust
    /// pipeline can decode without a local file, and injects a
    /// CloudSidecarStore so XMP edits persist back to the server.
    @MainActor
    private func openCloudAsset(_ asset: SearchAsset, server: URL) {
        let httpClient = makeAuthenticatedHTTPClient(server: server)
        // libraryPath is unused for this code path — we never call
        // source.images() on a single-asset open. Pass the asset's
        // parent dir so a hypothetical navigate() lands somewhere
        // sensible.
        let parentPath = (asset.abs_path as NSString).deletingLastPathComponent
        let source = CloudSource(server: server,
                                 folderID: asset.folder_id,
                                 libraryPath: parentPath,
                                 httpClient: httpClient)
        // The cloud asset's editor id matches the web's `fs:<absPath>`
        // shape so CloudSource.thumb / rawBytes pull paths from id.
        let imageRef = ImageRef(id: asset.id, displayName: asset.filename, url: nil)
        let assetRef = AssetRef(
            displayName: asset.filename,
            hintExtension: (asset.filename as NSString).pathExtension.lowercased(),
            stableID: asset.id,
            bytesProvider: { [source, imageRef] in try await source.rawBytes(for: imageRef) }
        )
        if sessions[assetRef.id] == nil {
            let remoteStore = CloudSidecarStore(server: server, assetID: asset.id, httpClient: httpClient)
            let session = EditSession(asset: assetRef, remoteSidecarStore: remoteStore)
            sessions[assetRef.id] = session
            Task { await session.loadSidecar() }
        }
        browseVM.loadSingleCloudAsset(assetRef)
        mode = .fullImage
    }

    // MARK: - Restore

    @MainActor
    private func restoreLastSource() async {
        guard let selection = SourceSelectionStore.load() else {
            // Nothing saved → auto-pick the first sensible source so the
            // user lands on something instead of an empty grid that says
            // "Pick a folder in the sidebar." Priority: cloud > local > none.
            await autoPickInitialSource()
            return
        }
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
        case .photoKit, .photoKitFilter:
            // Do NOT auto-load Photos on cold start. The user opted into
            // PhotoKit in a previous session; that's no excuse to ambush them
            // with a library of thousands of images every launch. They click
            // a Photos filter explicitly if they want it this session.
            break
        case .smb(let share):
            connectSavedSMB(share)
        case .cloudLibrary(let serverID, let folderID, let libraryPath):
            loadCloudLibrary(serverID: serverID, folderID: folderID, libraryPath: libraryPath)
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
        let remoteStore: (any SidecarStoreProtocol)? = {
            // Cloud-backed asset: route XMP through CloudSidecarStore so
            // edits round-trip via PUT /api/assets/<id>/xmp. Local files
            // (folder/SMB) keep using XMPSidecarStore via EditSession's
            // primaryURL branch. Cloud refs carry the upstream asset id
            // in stableID (set by BrowseViewModel.loadSource).
            guard case .cloudLibrary(let serverID, _) = librarySelection,
                  let assetID = asset.stableID
            else { return nil }
            return CloudSidecarStore(
                server: serverID,
                assetID: assetID,
                httpClient: makeAuthenticatedHTTPClient(server: serverID))
        }()
        let session = EditSession(asset: asset, remoteSidecarStore: remoteStore)
        sessions[asset.id] = session
        Task { await session.loadSidecar() }
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

// MARK: - AddMapleCloud sheet target

/// Backing value for `.sheet(item:)` so dismissal automatically resets to
/// `nil`. Two cases mirror the two entry points: a fresh "+" tap and a
/// click on a saved server whose tokens were cleared.
enum AddCloudSheetTarget: Identifiable, Equatable {
    case fresh
    case prefilled(String)

    var id: String {
        switch self {
        case .fresh: return ""
        case .prefilled(let host): return host
        }
    }

    var prefill: String {
        switch self {
        case .fresh: return ""
        case .prefilled(let host): return host
        }
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

