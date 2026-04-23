// AppShell.swift — Three-column NavigationSplitView (Mac/iPad) +
// TabView single-column collapse (iPhone).
//
// Keyboard shortcuts per spec § 09:
//   Stars 1-5, P/X flags — handled in BrowseGrid
//   Arrow navigation    — handled in BrowseGrid
//   ⌘E export          — triggers ExportPanel
//   ⌘\ sidebar toggles — NavigationSplitView column visibility
//   ⌘Z undo / ⌘⇧Z redo — forwarded to active EditSession

import SwiftUI
import MapleCore

// MARK: - AppShell

struct AppShell: View {
    // `@State` is the idiomatic binding for `@Observable` reference types;
    // the view tracks the instance's identity and SwiftUI observes property
    // access through the macro-generated storage.
    @State private var browseVM = BrowseViewModel()
    @State private var sessions: [AssetRef.ID: EditSession] = [:]
    @State private var showExport = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showFilePicker = false

    private var selectedSession: EditSession? {
        browseVM.selectedID.flatMap { sessions[$0] }
    }

    var body: some View {
        Group {
            #if os(iOS)
            adaptiveShell
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
    }

    // MARK: - Mac / iPad (NavigationSplitView)

    private var macShell: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            // Sidebar: source list
            SourceSidebar(onOpenFolder: { showFilePicker = true })
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
        } content: {
            // Center: Browse grid
            BrowseGrid(vm: browseVM, sessions: $sessions)
                .navigationSplitViewColumnWidth(min: 300, ideal: 520)
                .navigationTitle("Maple")
                .toolbar { browseToolbar }
        } detail: {
            // Detail: Full image + adjustment panel
            if let session = selectedSession {
                HStack(spacing: 0) {
                    FullImageView(session: session)
                    Divider().overlay(MapleTokens.border)
                    DetailPanel(session: session)
                }
            } else {
                emptyDetailView
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    // MARK: - iPhone (TabView)

    private var adaptiveShell: some View {
        TabView {
            NavigationStack {
                BrowseGrid(vm: browseVM, sessions: $sessions)
                    .navigationTitle("Maple")
                    .toolbar { browseToolbar }
            }
            .tabItem { Label("Browse", systemImage: "photo.on.rectangle") }

            Group {
                if let session = selectedSession {
                    NavigationStack {
                        FullImageView(session: session)
                            .navigationTitle(session.asset.displayName)
                    }
                } else {
                    emptyDetailView
                }
            }
            .tabItem { Label("Edit", systemImage: "slider.horizontal.3") }

            Group {
                if let session = selectedSession {
                    NavigationStack { DetailPanel(session: session) }
                } else {
                    emptyDetailView
                }
            }
            .tabItem { Label("Info", systemImage: "info.circle") }
        }
        .accentColor(MapleTokens.primary)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var browseToolbar: some ToolbarContent {
        ToolbarItem(placement: .automatic) {
            Button("Open Folder", systemImage: "folder.badge.plus") {
                showFilePicker = true
            }
        }
        ToolbarItem(placement: .automatic) {
            Button("Export", systemImage: "square.and.arrow.up") {
                showExport = true
            }
            .disabled(selectedSession == nil)
            .keyboardShortcut("e", modifiers: .command)
        }
        ToolbarItem(placement: .automatic) {
            Button("Toggle Sidebar", systemImage: "sidebar.leading") {
                withAnimation { columnVisibility = columnVisibility == .all ? .doubleColumn : .all }
            }
            .keyboardShortcut("\\", modifiers: .command)
        }
    }

    // MARK: - Helpers

    private var emptyDetailView: some View {
        VStack(spacing: 16) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 48))
                .foregroundStyle(MapleTokens.textMuted)
            Text("Open a folder to begin")
                .foregroundStyle(MapleTokens.textMuted)
            Button("Open Folder") { showFilePicker = true }
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.bg)
    }

    // All mutations of `sessions` go through `@MainActor`-isolated methods on
    // `AppShell` (which is a `@MainActor` `View`); that makes the dictionary
    // main-thread-serialised without wrapping it in another observable class.
    @MainActor
    private func loadFolder(url: URL) {
        // Delegate the actual directory walk + sort + selection to the
        // view model — it owns the generation counter for stale-write rejection.
        browseVM.loadFolder(url: url)

        // Pre-create EditSessions for newly discovered assets.
        for asset in browseVM.assets where sessions[asset.id] == nil {
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            Task { await session.loadSidecar() }
        }
    }
}

// MARK: - SourceSidebar

struct SourceSidebar: View {
    let onOpenFolder: () -> Void

    var body: some View {
        List {
            Section("Sources") {
                Label("Files", systemImage: "folder")
                    .foregroundStyle(MapleTokens.textMain)
                Label("Photos", systemImage: "photo")
                    .foregroundStyle(MapleTokens.textMain)
                Label("Network (SMB)", systemImage: "network")
                    .foregroundStyle(MapleTokens.textMuted)
            }
        }
        .listStyle(.sidebar)
        .background(MapleTokens.sidebar)
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button("Open Folder", systemImage: "folder.badge.plus", action: onOpenFolder)
            }
        }
    }
}
