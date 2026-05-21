// AppShell.swift — NavigationSplitView (Mac/iPad) +
// TabView single-column collapse (iPhone).
//
// Layout ported from docs/mockup.html:
//   • LibrarySidebar   — Folders / Photos Library / Connections tree
//   • BrowseGrid       — lazy thumbnail grid with empty-state + error banner
//   • DetailPanel      — third column only in Full-image mode; Browse drops
//                        the panel entirely so the grid takes the full width
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
    // by `body` / drawer code stay `private`.
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
            // .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md.
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

    @ViewBuilder
    private var macShell: some View {
        // In Browse mode the detail panel is suppressed entirely — the
        // explorer grid takes the full content area. In Full-image mode
        // the panel comes back as the third column for Develop + Info.
        // We switch the NavigationSplitView column count rather than
        // collapsing the detail to zero width, because SwiftUI still
        // reserves space for an empty detail column.
        Group {
            if mode == .fullImage {
                macShellFullImage
            } else {
                macShellBrowse
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .frame(minWidth: 520, minHeight: 460)
        }
    }

    private var macShellFullImage: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            librarySidebarView
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
        } content: {
            centerColumnView
                .navigationSplitViewColumnWidth(min: 300, ideal: 520)
                .navigationTitle(selectedSession?.asset.displayName ?? "Image")
                .toolbar { browseToolbarContent }
        } detail: {
            // `isFullImage` drives Ticket 12 bugs 4/5/8: the panel auto-flips
            // to Develop on entry, back to Info on exit. Width: iPad expands
            // the column toward `max` (~half the screen when balanced), so
            // DetailPanelWidth tightens the range there to just fit the
            // slider rail. macOS keeps the original range.
            DetailPanel(session: selectedSession, isFullImage: true)
                .modifier(DetailPanelWidth())
        }
        .navigationSplitViewStyle(.balanced)
    }

    private var macShellBrowse: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            librarySidebarView
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
        } detail: {
            centerColumnView
                .navigationTitle("Library — \(libraryTitle)")
                .toolbar { browseToolbarContent }
        }
        .navigationSplitViewStyle(.balanced)
    }

    private var librarySidebarView: some View {
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
    }

    @ViewBuilder
    private var centerColumnView: some View {
        // The center column switches between the explorer grid (browse
        // mode) and the full-image editor (fullImage mode). Per the
        // mockup, these are two different center views — not a
        // side-by-side. Double-click on a thumbnail flips the mode.
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
            browseToolbarContent
            // Info button reaches the DetailPanel sheet; only meaningful
            // in Full-image mode (the panel is suppressed entirely in
            // Browse — sidecar info belongs to the editor view).
            if mode == .fullImage {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { iPhoneInfoSheet = true } label: {
                        Image(systemName: "info.circle")
                    }
                    .accessibilityLabel("Info")
                }
            }
            // Settings gear is provided by `browseToolbar` — don't duplicate
            // it here, or two buttons share the same accessibilityIdentifier
            // and UI-test lookups become ambiguous.
        }
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
            browseDisplayMode: $browseDisplayMode,
            onBack: { mode = .browse },
            onExport: { showExport = true },
            onOpenFolder: { showFilePicker = true },
            onSettings: { showSettings = true }
        )
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
