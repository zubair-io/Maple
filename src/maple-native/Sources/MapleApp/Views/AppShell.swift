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
    @StateObject private var browseVM = BrowseViewModel()
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

    private func loadFolder(url: URL) {
        // For macOS the folder URL from fileImporter is already accessible.
        // Full security-scoped bookmark handling is in FilesystemSource.
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(
            at: url, includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        let raws = contents.filter { RAWExtensions.all.contains($0.pathExtension.lowercased()) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { AssetRef(url: $0) }

        browseVM.assets = raws

        // Pre-create EditSessions for all assets.
        for asset in raws where sessions[asset.id] == nil {
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            Task { await session.loadSidecar() }
        }
        browseVM.selectedID = raws.first?.id
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
