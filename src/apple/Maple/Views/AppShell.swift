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

    // Source-picker state (sidebar → sheet).
    @State private var selectedSourceKind: SourceKind = .files
    @State private var showSMBSheet = false
    @State private var showSelfHostedSheet = false

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
            // Restore last-used source on cold start.
            await restoreLastSource()
        }
    }

    // MARK: - Mac / iPad (NavigationSplitView)

    private var macShell: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            // Sidebar: source list
            SourceSidebar(
                selected: $selectedSourceKind,
                onFilesTapped: { showFilePicker = true },
                onPhotosTapped: { requestPhotosAccess() },
                onSMBTapped: { showSMBSheet = true },
                onSelfHostedTapped: { showSelfHostedSheet = true }
            )
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
        // Configure folder-scoped caches so thumbnails land in the folder's
        // .maple/ directory (matches Maple Hosted).
        Task.detached {
            await ThumbnailDiskCache.shared.configure(folderURL: url)
            await RenderedPreviewCache.shared.configure(folderURL: url)
        }

        // Delegate the actual directory walk + sort + selection to the
        // view model — it owns the generation counter for stale-write rejection.
        browseVM.loadFolder(url: url)
        selectedSourceKind = .files

        // Pre-create EditSessions for newly discovered assets.
        for asset in browseVM.assets where sessions[asset.id] == nil {
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            Task { await session.loadSidecar() }
        }

        // Persist bookmark-backed selection so the app re-opens here.
        Task.detached(priority: .utility) {
            let fs = FilesystemSource()
            do {
                try await fs.open(folderURL: url)
                if let data = await fs.persistableBookmark {
                    SourceSelectionStore.save(.filesystem(bookmark: data))
                }
            } catch {
                // Non-fatal — next launch simply lands on the empty state.
            }
        }
    }

    // MARK: - PhotoKit

    @MainActor
    private func requestPhotosAccess() {
        selectedSourceKind = .photos
        Task { @MainActor in
            let source = PhotoKitSource()
            do {
                try await source.requestAccessAndFetch()
                await browseVM.loadSource(source)
                SourceSelectionStore.save(.photoKit)
                primeSessionsForCurrentAssets()
            } catch {
                browseVM.loadError = error
            }
        }
    }

    // MARK: - SMB

    @MainActor
    private func connectSMB(credentials: SMBSource.Credentials) {
        selectedSourceKind = .network
        Task { @MainActor in
            // Persist credentials to Keychain for next launch.
            try? await SMBCredentialStore.shared.save(credentials)

            let source = SMBSource()
            do {
                try await source.connect(credentials: credentials, remotePath: "/")
                await browseVM.loadSource(source)
                SourceSelectionStore.save(.smb(
                    SMBCredentialStore.SavedShare(
                        host: credentials.host,
                        share: credentials.share,
                        username: credentials.username
                    )
                ))
                primeSessionsForCurrentAssets()
            } catch {
                browseVM.loadError = error
            }
        }
    }

    // MARK: - Self Hosted

    @MainActor
    private func connectSelfHosted(baseURL: URL, token: String?) {
        selectedSourceKind = .selfHosted
        Task { @MainActor in
            // Persist the token to Keychain (non-fatal on failure).
            if let token {
                try? await SelfHostedCredentialStore.shared.setToken(token, forServerURL: baseURL)
            }

            let source = SelfHostedSource(baseURL: baseURL, token: token)
            await browseVM.loadSource(source)
            SourceSelectionStore.save(.selfHosted(baseURL: baseURL))
            primeSessionsForCurrentAssets()
        }
    }

    // MARK: - Restore

    @MainActor
    private func restoreLastSource() async {
        guard let selection = SourceSelectionStore.load() else { return }
        switch selection {
        case .filesystem(let bookmark):
            let fs = FilesystemSource()
            do {
                try await fs.restore(fromBookmarkData: bookmark)
                let fileAssets = await fs.assets
                if let first = fileAssets.first?.url {
                    let folder = first.deletingLastPathComponent()
                    await ThumbnailDiskCache.shared.configure(folderURL: folder)
                    await RenderedPreviewCache.shared.configure(folderURL: folder)
                }
                await browseVM.loadSource(fs)
                selectedSourceKind = .files
                primeSessionsForCurrentAssets()
            } catch {
                SourceSelectionStore.clear()
            }
        case .photoKit:
            requestPhotosAccess()
        case .smb(let share):
            if let creds = await SMBCredentialStore.shared.credentials(for: share) {
                connectSMB(credentials: creds)
            } else {
                // Keychain entry missing — prompt user again.
                showSMBSheet = true
            }
        case .selfHosted(let baseURL):
            if let token = await SelfHostedCredentialStore.shared.tokenForServerURL(baseURL) {
                connectSelfHosted(baseURL: baseURL, token: token)
            } else {
                // Keychain entry missing — prompt user to re-pair.
                showSelfHostedSheet = true
            }
        }
    }

    @MainActor
    private func primeSessionsForCurrentAssets() {
        for asset in browseVM.assets where sessions[asset.id] == nil {
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            Task { await session.loadSidecar() }
        }
    }
}

// MARK: - SourceKind

/// Which sidebar row is selected; drives the accent highlight and the
/// UserDefaults-persisted last-used source.
enum SourceKind: Hashable {
    case files, photos, network, selfHosted
}

// MARK: - SourceSidebar

struct SourceSidebar: View {
    @Binding var selected: SourceKind
    let onFilesTapped: () -> Void
    let onPhotosTapped: () -> Void
    let onSMBTapped: () -> Void
    let onSelfHostedTapped: () -> Void

    var body: some View {
        List {
            Section("Sources") {
                SourceRow(kind: .files, label: "Files", icon: "folder",
                          selected: $selected, action: onFilesTapped)
                SourceRow(kind: .photos, label: "Photos", icon: "photo",
                          selected: $selected, action: onPhotosTapped)
                SourceRow(kind: .network, label: "Network (SMB)", icon: "network",
                          selected: $selected, action: onSMBTapped)
                SourceRow(kind: .selfHosted, label: "Self Hosted", icon: "cloud",
                          selected: $selected, action: onSelfHostedTapped)
            }
        }
        .listStyle(.sidebar)
        .background(MapleTokens.sidebar)
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button("Open Folder", systemImage: "folder.badge.plus", action: onFilesTapped)
            }
        }
    }
}

// MARK: - SourceRow

private struct SourceRow: View {
    let kind: SourceKind
    let label: String
    let icon: String
    @Binding var selected: SourceKind
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(selected == kind ? MapleTokens.primary : MapleTokens.textMuted)
                Text(label)
                    .foregroundStyle(MapleTokens.textMain)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(
            selected == kind ? MapleTokens.bgActive : Color.clear
        )
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected == kind ? [.isSelected] : [])
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

// MARK: - Self-Hosted sheet

struct SelfHostedPickerSheet: View {
    let onConnect: (URL, String?) -> Void
    let onCancel: () -> Void

    @State private var serverURL = ""
    @State private var token = ""
    #if os(iOS)
    @State private var showingScanner = false
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect to Self-Hosted Server")
                .font(.title3).bold()
            Form {
                TextField("Server URL (e.g. https://maple.local)", text: $serverURL)
                SecureField("Bearer token (optional)", text: $token)
            }
            HStack {
                #if os(iOS)
                Button {
                    showingScanner = true
                } label: {
                    Label("Scan QR…", systemImage: "qrcode.viewfinder")
                }
                .accessibilityLabel("Scan pairing QR code")
                #endif
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
        #if os(iOS)
        .sheet(isPresented: $showingScanner) {
            QRScannerView { payload in
                showingScanner = false
                // Expected payload: { "url": "...", "token": "..." }.
                // Pre-fill the fields — the user still hits Connect to commit.
                if let decoded = try? JSONDecoder().decode(
                    PairingEnvelope.self,
                    from: Data(payload.utf8)
                ) {
                    serverURL = decoded.url
                    if let t = decoded.token { token = t }
                }
            } onCancel: {
                showingScanner = false
            }
        }
        #endif
        .frame(minWidth: 420)
    }
}
