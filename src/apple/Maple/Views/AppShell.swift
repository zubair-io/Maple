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
//   • PhoneTabShell        — iPhone bottom-tab shell (Library / Search /
//                            Settings) with a per-tab NavigationStack.
//                            (file: PhoneTabShell.swift, #if os(iOS);
//                            wraps PhoneLibraryView → AppShellIPhoneShell)
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
import OSLog
#if os(iOS)
import UIKit
#endif

private let appShellLog = Logger(subsystem: "app.justmaple.aperture", category: "appshell")

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
    /// Scene activation hook (#1769, iOS): Metal discards presents issued
    /// while the app is backgrounded, so a GPU-live canvas backgrounded
    /// mid-present can come back torn with nothing scheduled to repaint it.
    /// On `.active` we ask the active editor session for one re-present.
    @Environment(\.scenePhase) private var scenePhase
    @State private var showExport = false
    @State private var showSettings = false
    // Held in @State (not constructed inside the .sheet content closure) so a
    // re-render of AppShell while the sheet is open cannot rebuild the view model
    // and discard the user's in-progress edits. nil = sheet closed.
    @State private var batchMetadataVM: BatchMetadataViewModel?
    /// Non-nil when the Settings sheet should open on a specific tab.
    /// Set to `.pano` by the PanoMergeView "Configure in Settings → Pano"
    /// callback so the sheet lands directly on the Pano tab. (#1241)
    @State private var settingsInitialTab: SettingsTab? = nil
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    /// Whether the S5 editor's right-hand Info inspector is shown on the
    /// Mac/iPad pane shell. The editor's `(i)` button toggles this (#875
    /// item 2). Defaults to `true` so the inspector is visible on entry
    /// (matching the prior always-visible detail column). Uses
    /// `.inspector(isPresented:)` rather than a column-count swap so the
    /// `EditorSessionHost`'s `@State` (armed tool / fine-mode, #816)
    /// survives a toggle — swapping the NavigationSplitView column count
    /// changes the content subtree's identity and would reset it.
    @State private var editorDetailVisible = true
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
    /// #1381 — the cloud folder to reopen after a re-sign-in triggered by an
    /// auth error. Set alongside `addCloudSheetTarget = .prefilled(...)`;
    /// replayed (then cleared) by the sheet's `onSignedIn`.
    @State var pendingCloudReopen: PendingCloudOpen?

    // Dynamic toolbar title — reflects the last-loaded source/filter.
    @State var libraryTitle: String = "All"

    // Browse vs editor mode. Default to browse. `Mode` is internal (was
    // `private`) so the action extensions can write it after a source
    // load completes.
    //
    //   • `.preview` — the fast static `PreviewView` (Fast Preview §1). The
    //     default target of a grid tap on the Mac/iPad pane shell: a
    //     cached-JPEG surface with a Flag/Edit/Info bar + filmstrip that
    //     mounts NO render pipeline (no EditSession render, no GPU/CPU canvas,
    //     no zoom controller). Edit flips to `.editing`; back returns to
    //     `.browse`. The iPhone shell doesn't use this — it pushes
    //     `PreviewDestination` onto its Library-tab NavigationStack instead.
    //   • `.editing` — the S5 `EditorView` (group tabs + tool pills). The
    //     Mac/iPad pane shell flips to this when the user opens an image
    //     (#815). The pane shell has no NavigationStack, so the editor
    //     mounts in the center column rather than being pushed.
    //   • `.panoramaMerge` — the PanoMergeView (M2, #1236). Presented as a
    //     modal sheet on both Mac/iPad and iPhone via `.sheet(isPresented:)`.
    //     Cancel/Done dismisses the sheet and returns to `.browse`.
    //
    // The legacy `.fullImage` case (the `FullImageView` zoom/pan loupe) was
    // retired in #1807 once Preview + the S5 editor covered every path that
    // used to reach it — the iPhone shell pushes the editor onto the Library
    // tab's NavigationStack instead of flipping `mode` (#791/#809), and the
    // UITest visual-harness fast path (AppShell+UITestFixture) already keyed
    // on `.editing`, not `.fullImage`.
    enum Mode { case browse, preview, editing, panoramaMerge }
    @State var mode: Mode = .browse

    /// PanoMergeSession drives the panorama merge view. Created when the
    /// user hits "Merge to panorama…" and torn down (session reset) on
    /// cancel or navigation away. Uses RustPanoStitcher (M4, #1234) so the
    /// real FFI stitch runs; MockPanoStitcher is retained for unit tests only.
    @State var panoMergeSession: PanoMergeSession = PanoMergeSession(stitcher: RustPanoStitcher())

    /// True when an image surface is open (`.preview` or `.editing`) — i.e.
    /// the center column is showing an image, not the browse grid. The
    /// Mac/iPad three-column layout and the navigation title key off "is an
    /// image open?", which both answer yes to. (Back/export affordances now
    /// live inside Preview/Editor, not the window toolbar.)
    var isImageOpen: Bool { mode == .preview || mode == .editing }

    /// Mode to enter when the user opens an image from the grid. Fast Preview
    /// §1: every pane-shell open now lands on the fast static `.preview`
    /// surface (the editor is reached only from Preview's Edit button). The
    /// iPhone shell doesn't consume this — it pushes `PreviewDestination` onto
    /// its Library-tab NavigationStack — so the pane shell is the only reader,
    /// but the value is idiom-independent per the design ("resolves to
    /// `.preview` on all idioms").
    var imageOpenMode: Mode { .preview }

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
    #endif

    /// Observable singleton that captures incoming `maple://` URLs at
    /// the `MapleApp` scene level. SwiftUI's `.onChange(of:)` only
    /// re-evaluates an `@Observable` property when SOME view in the
    /// body actually reads it during render, so the binding here is
    /// load-bearing — without it the warm-launch path (a second
    /// `.onOpenURL` after the app is up) would never fire `consume()`.
    /// Spec: docs/design/responsive-program/deep-links.md §2.
    @State private var deepLinkRouter = DeepLinkRouter.shared
    @State private var documentOpenRouter = DocumentOpenRouter.shared

    #if os(iOS)

    /// iPhone drawer snapped state. `dragOffset` (the in-flight finger
    /// translation) lives inside `AppShellIPhoneDrawer` as private
    /// `@State` — only the snapped flag crosses the boundary, since the
    /// hamburger button in `iPhoneMain` writes it directly.
    @State private var isDrawerOpen: Bool = false

    /// The iPhone Library tab's NavigationStack path (Fast Preview §1).
    /// Hoisted here from `PhoneTabShell` (and passed back down as a binding)
    /// so the non-tap image-open paths — deep link + document open, which run
    /// in `AppShell` extensions and can't reach `PhoneTabShell`'s private
    /// state — can push `.preview(asset)` onto the SAME stack a grid tap uses,
    /// instead of the pane-shell `mode` flip that the iPhone shell doesn't
    /// render. Default-internal (not `private`) so `openEditor` /
    /// `consumePendingDeepLink` / `consumePendingOpenedDocument` can append.
    @State var libraryPath: [LibraryDestination] = []
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

    /// Histogram client for the currently-open cloud asset (#633). Set
    /// when `openCloudAsset(_:server:)` builds the editor session — the
    /// AuthenticatedHTTPClient is reused with the existing
    /// `cloudTimelineThumbClient` to preserve the 401-refresh coalescer.
    /// `nil` when no cloud asset is selected, which short-circuits
    /// `HistogramBlock` back to the placeholder.
    @State var cloudHistogramClient: CloudHistogramClient?

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

    /// Pane-shell (iPad/Mac) memory guard: keep only the active editor's session
    /// resident. Each EditSession holds GPU live buffers + a decoded cache —
    /// roughly one large RAW's worth — and the `open*` actions cache every opened
    /// asset in `sessions` without ever pruning, so switching between two 100 MP
    /// RAWs held both resident and jetsam-killed iOS at the per-process limit
    /// (#1660). Called when an editor opens and when the active asset changes;
    /// no-op while browsing (so the folder pre-create priming survives the grid).
    /// The iPhone shell prunes in `EditorDestination` — this is its pane-shell +
    /// filmstrip equivalent.
    @MainActor
    func pruneInactiveSessions() {
        guard isImageOpen, let id = browseVM.selectedID else { return }
        if let active = sessions[id] {
            // Active session already resident — drop every other one. The
            // `count > 1` guard avoids a spurious @State rewrite (and shell
            // re-render) when it's already the only entry.
            if sessions.count > 1 { sessions = [id: active] }
        } else {
            // The active asset's session isn't resident yet. Today every
            // in-editor switch routes through `openEditor`, which instantiates
            // the session BEFORE mutating `selectedID`, so this branch is a
            // guard against a future path that flips `selectedID` first: free
            // every prior session so the old large RAW's buffers are gone
            // before the new decode runs, rather than early-returning and
            // leaving them resident while the next image loads (#1660). The
            // active session is then (re)created by `openEditor`. Mirrors
            // EditorDestination's `sessions = [:]` pruning (#1661 review).
            sessions = [:]
        }
    }

    var body: some View {
        Group {
            // Shell selection goes through `MapleShellKind.current`
            // (responsive-program S0a, #581). Direct `UIDevice.userInterfaceIdiom`
            // calls are forbidden elsewhere — grep should show zero hits outside
            // MapleCore/Layout/MapleLayout.swift. `phoneTabShell` is `#if os(iOS)`
            // only (it's the iPhone tab-bar shell from S1a, #597), so the macOS
            // branch never references it and always renders the pane shell directly.
            #if os(iOS)
            if MapleShellKind.current == .phoneTab {
                // iPhone idiom → bottom-tab shell (Library / Search / Settings),
                // each tab a NavigationStack. Always phone-tier; no
                // GeometryReader needed (width is implicitly <768pt).
                phoneTabShell
                    .environment(\.mapleLayout, .phone)
            } else {
                paneShellWithLayout
            }
            #else
            paneShellWithLayout
            #endif
        }
        // #633 — InfoPanel/HistogramBlock reads this. nil ⇒ placeholder
        // (local/PhotoKit assets, no cloud asset open). Set + cleared by
        // `openCloudAsset` / the library-selection reset below.
        .environment(\.cloudHistogramClient, cloudHistogramClient)
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
                onDismiss: {
                    addCloudSheetTarget = nil
                    // The user backed out of re-signing-in — drop any pending
                    // folder reopen so it can't replay on a later sign-in.
                    pendingCloudReopen = nil
                },
                onSignedIn: { url, tokens, _ in
                    Task { @MainActor in
                        try? TokenStore.save(tokens, server: url)
                        CloudServerRegistry.shared.register(url)
                        // Refresh the per-server AuthSession cache so the
                        // sidebar sees the user as signed in immediately.
                        let session = sessionFor(url)
                        await session.bootstrapAndRestore()
                        addCloudSheetTarget = nil
                        // #1381: if this sign-in was triggered by a folder open
                        // that hit an auth error, replay that load now so the
                        // user lands on their photos, not the error screen.
                        if let pending = pendingCloudReopen, pending.serverID == url {
                            pendingCloudReopen = nil
                            loadCloudLibrary(serverID: pending.serverID,
                                             folderID: pending.folderID,
                                             libraryPath: pending.libraryPath)
                        }
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
                cloudHistogramClient = nil
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
            // Cold-start deep link wins over the restored source. The
            // URL was captured by `.onOpenURL` at `MapleApp` level
            // before this `.task` ran; consume now that the restored
            // selection has settled so the navigation lands on the
            // deep-link destination, not the restored grid.
            // Implementation: AppShell+DeepLink.swift.
            consumePendingDeepLink()
            // Cold-start opened document ("Open With Maple" / `open -a`) —
            // captured by `.onOpenURL` before this `.task` ran. Consumed after
            // restore so the opened file lands as the active editor session.
            // Implementation: AppShell+DocumentOpen.swift (#1589).
            consumePendingOpenedDocument()
        }
        // Warm-launch delivery. An `.onOpenURL` while the app is
        // already foregrounded sets `pendingDestination`; we observe
        // via the `@State`-bound singleton so SwiftUI registers the
        // dependency and re-evaluates `.onChange(of:)` on each write.
        // Spec §2.
        .onChange(of: deepLinkRouter.pendingDestination) { _, newValue in
            guard newValue != nil else { return }
            consumePendingDeepLink()
        }
        // Warm-launch opened document — an `.onOpenURL` file delivery while the
        // app is foregrounded sets `pendingFileURL`; observe it (the
        // `@State`-bound singleton registers the dependency) and open the file.
        // #1589.
        .onChange(of: documentOpenRouter.pendingFileURL) { _, newValue in
            guard newValue != nil else { return }
            consumePendingOpenedDocument()
        }
    }

    // MARK: - Mac / iPad

    /// Pane shell (macShell) wrapped in `GeometryReader` so that the
    /// width-derived `MapleLayout` env value flows to child views.
    /// Responsive-program S0a (#581).
    @ViewBuilder
    private var paneShellWithLayout: some View {
        GeometryReader { proxy in
            macShell
                .environment(\.mapleLayout, MapleLayout.from(width: proxy.size.width))
        }
    }

    @ViewBuilder
    private var macShell: some View {
        AppShellMacLayout(
            // Every image mode (`.preview`, `.editing`) collapses the browse
            // grid to the image surface.
            isFullImage: isImageOpen,
            // Fast Preview §1: the static Preview surface on `.preview`;
            // otherwise (i.e. `.editing`) the S5 EditorView. iPhone never
            // gets here — `phoneTabShell` is the iPhone path.
            usePreview: mode == .preview,
            columnVisibility: $columnVisibility,
            editorDetailVisible: $editorDetailVisible,
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
            onFullImageFallback: { mode = .browse },
            // S5 EditorView callbacks (#815). Dismiss returns to the browse
            // grid. Share reuses the existing ⌘E ExportPanel the desktop
            // already has.
            // Info reveals the DetailPanel third column — on the pane shell
            // the info/develop inspector is that column, not a sheet (the
            // iPhone-only Info sheet), so the button's job is to make sure
            // the column is visible (e.g. after the user collapsed it via
            // the Library toggle).
            // Fast Preview §1: the editor's back returns to Preview, not
            // straight to the grid (`grid → Preview → Editor` back stack).
            onEditorDismiss: { mode = .preview },
            onEditorShare: { showExport = true },
            // Toggle the editor's Info inspector (#875 item 2). On the pane
            // shell the info surface is the right-hand inspector, shown via
            // `.inspector(isPresented:)` — toggling preserves the editor's
            // armed-tool / fine-mode state (#816), unlike a column swap.
            onEditorInfo: { withAnimation { editorDetailVisible.toggle() } },
            // Fast Preview §1: Preview's Edit button flips the pane shell into
            // the S5 editor for the same asset. The asset is already selected
            // (`browseVM.selectedID`), and `ensureSession` primed a session on
            // grid appear, so the editor mounts against the warm session.
            onPreviewEdit: { asset in
                browseVM.selectedID = asset.id
                mode = .editing
            },
            // Fast Preview §1: Preview's back returns to the browse grid.
            onPreviewDismiss: { mode = .browse },
            // M2 panorama merge (#1236).
            onMergePanorama: { openPanoramaMerge() },
            // M4 batch metadata editor (#1629).
            onEditMetadata: { openBatchMetadata() }
        )
        .sheet(isPresented: $showSettings, onDismiss: { settingsInitialTab = nil }) {
            SettingsView(initialTab: settingsInitialTab)
                .frame(minWidth: 540, minHeight: 480)
        }
        .sheet(item: $batchMetadataVM) { vm in
            BatchMetadataSheet(vm: vm, onDismiss: { batchMetadataVM = nil })
        }
        // M2: panorama merge view — presented as a sheet on Mac/iPad.
        // Covers the full content area; Cancel dismisses back to Browse
        // and exits select mode.
        .sheet(isPresented: Binding(
            get: { mode == .panoramaMerge },
            set: { if !$0 { dismissPanoramaMerge() } }
        )) {
            PanoMergeView(
                assets: browseVM.selectedAssets,
                session: panoMergeSession,
                onDismiss: { dismissPanoramaMerge() },
                // M5 (#1234): inject the stitched PNG into the library so it
                // shows in the browse grid and is auto-selected.
                onComplete: { result in browseVM.injectPanoResult(url: result.outputURL) },
                // M6 provisioning (#1241): modelsNotInstalled error offers a
                // "Configure in Settings → Pano" button. We dismiss the pano
                // sheet first, then open Settings on the Pano tab so the user
                // can configure paths without the sheet stacking on top.
                onOpenPanoSettings: {
                    dismissPanoramaMerge()
                    settingsInitialTab = .pano
                    showSettings = true
                }
            )
            #if os(macOS)
            .frame(minWidth: 560, minHeight: 480)
            #endif
        }
        // Full-bleed editor (#1586): hide the sources sidebar — and close the
        // right inspector — when an image is open, so the canvas-first chrome
        // floats over a full-bleed canvas (matching the web/design, where the
        // floating filmstrip/dock replace the side panels). The sidebar
        // returns on dismiss; ⌘\ and the Info button reopen them mid-session.
        .onChange(of: mode) { _, newMode in
            let imageOpen = (newMode == .preview || newMode == .editing)
            // Entering an image surface on the pane shell (iPad/Mac): drop every other
            // cached session so only the active asset's GPU + decoded buffers stay
            // resident. The open* actions cache every opened asset in `sessions`
            // and never prune, so two large RAWs held at once jetsam-killed iOS
            // (#1660). Covers the "select in grid, then open" path (selectedID
            // changed while browsing, so the watcher below didn't fire).
            if imageOpen { pruneInactiveSessions() }
            // The animated sidebar/inspector collapse read as janky on image
            // open/close — snap the column swap instantly, with animations
            // explicitly disabled so no ambient transaction re-animates it.
            var noAnim = Transaction()
            noAnim.disablesAnimations = true
            withTransaction(noAnim) {
                columnVisibility = imageOpen ? .detailOnly : .all
                if newMode == .editing { editorDetailVisible = false }
            }
        }
        // Filmstrip sibling switch (iPad/Mac) changes the active asset WITHOUT a
        // mode change — prune here too so the previous sibling's heavy resources
        // free before the new one renders.
        .onChange(of: browseVM.selectedID) { _, _ in
            pruneInactiveSessions()
        }
        // Foreground re-present (#1769, iOS): see the `scenePhase` property doc.
        // macOS windows aren't backgrounded the same way (presents aren't
        // discarded), so this is iOS-only.
        .onChange(of: scenePhase) { _, newPhase in
            #if os(iOS)
            if newPhase == .active {
                selectedSession?.representOnForeground()
            }
            #endif
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
            onSignInCloudServer: { url in
                // Sidebar "Sign in" — present prefilled re-auth for this
                // server. A pending folder reopen (if any) replays on success.
                addCloudSheetTarget = .prefilled(url.host ?? url.absoluteString)
            },
            sessionFor: sessionFor,
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
                        // disable() clears local config + tokens even if it
                        // throws, so the polling stops regardless; log a throw
                        // so a failed File Provider teardown is visible.
                        do {
                            try await FileProviderDomainController().disable(domainIdentifier: domainID)
                        } catch {
                            appShellLog.error("File Provider teardown failed for removed server \(domainID, privacy: .public) (local state still cleared): \(error.localizedDescription, privacy: .public)")
                        }
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
    /// iPhone tab-bar shell (responsive-program S1a, #597) — bottom
    /// `TabView` with three per-tab NavigationStacks (Library / Search /
    /// Settings). Library tab content is `PhoneLibraryView`, which wraps
    /// the existing `AppShellIPhoneShell` drawer + center column. Search
    /// is `PhoneSearchTab` (S7, #622); Settings embeds the existing `SettingsView`.
    @ViewBuilder
    private var phoneTabShell: some View {
        PhoneTabShell(
            libraryPath: $libraryPath,
            isDrawerOpen: $isDrawerOpen,
            mode: mode,
            selectedSession: selectedSession,
            libraryTitle: libraryTitle,
            iPhoneInfoSheet: $iPhoneInfoSheet,
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
            phoneSearchServerKey: phoneSearchServerKey,
            makePhoneSearchSession: { await makePhoneSearchSession() },
            resolveSearchAsset: { asset, server in prepareCloudSession(asset, server: server) },
            sidebar: { sharedSidebar },
            toolbarContent: { browseToolbarContent },
            // iPhone (#809): resolve the cloud / merged-PhotoKit asset's
            // session and hand its AssetRef back to PhoneTabShell, which pushes
            // the S5 EditorView onto the Library tab's NavigationStack — rather
            // than the legacy `openCloudAsset` / `openLocalPhotoKitAsset`
            // mode-flip handlers used by the Mac / iPad pane shell above. The
            // resolution logic (bytes provider, CloudSidecarStore, histogram
            // client) is identical — only the navigation target differs.
            onSelectCloudAsset: { asset, server in prepareCloudSession(asset, server: server) },
            onCloseSearch: { deactivateSearch() },
            onSelectLocalAsset: { ref in
                // Mirror the legacy `openLocalPhotoKitAsset` error handling
                // (AppShell+PhotoKitActions.swift): a `PhotoKitSource` init
                // failure must surface to the user via `browseVM.loadError`,
                // not be silently swallowed by `try?` (which would turn the
                // tap into a no-op). Returning `nil` tells `PhoneTabShell` not
                // to push the S5 EditorView. (#809)
                do {
                    return try prepareLocalPhotoKitSession(ref)
                } catch {
                    browseVM.loadError = error
                    return nil
                }
            },
            onGrantPhotosAccess: { grantPhotosAccessAndLoad() },
            onNavigateFolder: { url in navigateFolder(url) },
            onOpenEditor: { asset in openEditor(for: asset) },
            onPrimeSession: { asset in ensureSession(for: asset) },
            onFullImageFallback: { mode = .browse },
            onMergePanorama: { openPanoramaMerge() },
            onEditMetadata: { openBatchMetadata() }
        )
        // M2: panorama merge sheet for iPhone — same sheet as Mac/iPad,
        // but presented over the tab shell instead of the pane shell.
        .sheet(isPresented: Binding(
            get: { mode == .panoramaMerge },
            set: { if !$0 { dismissPanoramaMerge() } }
        )) {
            PanoMergeView(
                assets: browseVM.selectedAssets,
                session: panoMergeSession,
                onDismiss: { dismissPanoramaMerge() },
                // M5 (#1234): inject the stitched PNG into the library.
                onComplete: { result in browseVM.injectPanoResult(url: result.outputURL) },
                // M6 provisioning (#1241): direct not-provisioned errors to
                // Settings → Pano on iPhone as well.
                onOpenPanoSettings: {
                    dismissPanoramaMerge()
                    settingsInitialTab = .pano
                    showSettings = true
                }
            )
        }
        // M4: batch metadata editor sheet for iPhone — same sheet as Mac/iPad,
        // but presented over the tab shell instead of the pane shell.
        .sheet(item: $batchMetadataVM) { vm in
            BatchMetadataSheet(vm: vm, onDismiss: { batchMetadataVM = nil })
        }
    }
    #endif

    // MARK: - Deep-link helpers

    /// Reset every transient piece of UI (sheets + iPhone drawer)
    /// so a deep-link destination renders cleanly. Lives here, not
    /// in `AppShell+DeepLink.swift`, because several of the state
    /// vars below (`showSettings`, `showExport`, `iPhoneInfoSheet`,
    /// `isDrawerOpen`) are `private` to this file — keeping the
    /// helper internal-but-file-local lets the extension delegate
    /// without widening their access. Per spec §2 warm-launch
    /// behavior.
    @MainActor
    func dismissAllTransientUI() {
        showSMBSheet = false
        addCloudSheetTarget = nil
        showSettings = false
        settingsInitialTab = nil
        showExport = false
        #if os(iOS)
        iPhoneInfoSheet = false
        isDrawerOpen = false
        #endif
    }

    // MARK: - Toolbar

    /// Wires `AppShell` state into `AppShellToolbar` (defined in
    /// `AppShellToolbar.swift`). Kept as a small computed property so each
    /// call site can write `.toolbar { browseToolbarContent }` without
    /// repeating the parameter list.
    /// True on the iPhone tab-bar shell, where Library / Search / Settings
    /// live in the bottom tab bar (so the toolbar omits them). Mirrors the
    /// `MapleShellKind.current` check in `body`. Always false on macOS.
    private var isCompactShell: Bool {
        #if os(iOS)
        return MapleShellKind.current == .phoneTab
        #else
        return false
        #endif
    }

    @ToolbarContentBuilder
    private var browseToolbarContent: some ToolbarContent {
        AppShellToolbar(
            // `.editing` and `.preview` both own their chrome (back chevron,
            // export/share, filename), so the window toolbar suppresses every
            // browse control (fill/fit, select, cloud view-mode) for both —
            // only Library/Search/Settings survive so the sidebar stays
            // toggleable (#815; Fast Preview §1).
            isEditing: mode == .editing || mode == .preview,
            isCompact: isCompactShell,
            searchAvailable: searchAvailable,
            isSearchActive: isSearchActive,
            isCloudLibrary: searchAvailable,
            cloudViewMode: currentCloudViewMode,
            browseDisplayMode: $browseDisplayMode,
            onOpenSearch: { toggleSearch() },
            onSetCloudViewMode: { setCloudViewMode($0) },
            onOpenFolder: { showFilePicker = true },
            onSettings: { showSettings = true },
            // M1 multi-select (#1236): show the Select/Done toggle in browse mode only.
            isSelecting: browseVM.isSelecting,
            onToggleSelect: mode == .browse ? {
                if browseVM.isSelecting {
                    browseVM.exitSelectMode()
                } else {
                    browseVM.enterSelectMode()
                }
            } : nil
        )
    }

    // MARK: - Batch metadata actions (M4, #1629)

    /// Open the batch metadata editor with the currently-selected assets.
    private func openBatchMetadata() {
        guard !browseVM.selectedIDs.isEmpty else { return }
        // Snapshot the selection + sessions once, at open time. Presenting via
        // .sheet(item:) keeps this instance alive for the sheet's lifetime.
        batchMetadataVM = BatchMetadataViewModel(
            assets: browseVM.selectedAssets,
            sessions: sessions
        )
    }

    // MARK: - Panorama merge actions (M2, #1236)

    /// Open the panorama merge view with the currently-selected assets.
    /// Only called when `browseVM.canMergePanorama` is true.
    func openPanoramaMerge() {
        guard browseVM.canMergePanorama else { return }
        panoMergeSession.reset()
        mode = .panoramaMerge
    }

    /// Dismiss the panorama merge view and return to browse. Exits select
    /// mode so the grid resets to normal tap-to-open behaviour.
    ///
    /// Always cancels the in-flight stitch, regardless of how the sheet is
    /// dismissed (Cancel/Done button OR system swipe-down / Escape gesture).
    /// The `.sheet(isPresented:set:)` binding routes ALL dismissal paths here,
    /// so the stitch can never leak after the sheet is gone.
    func dismissPanoramaMerge() {
        panoMergeSession.cancel()
        mode = .browse
        browseVM.exitSelectMode()
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
