// LibrarySourcesSettingsView.swift — app-level Settings → Sources (#2925).
//
// The counterpart to the sidebar's hiding rule. `LibrarySidebar` now drops
// a whole section when it has nothing connected — no "No local folders"
// placeholder, no childless SMB row, no server section with zero reachable
// roots — which also drops that section's "+" button. This page is where
// sources are registered and removed instead, and where a source that has
// gone unreachable is still visible.
//
// Distinct from `ServerAdmin/SourcesSettingsView` (#2898), which lists one
// SERVER's library roots and their server-side connection status. That page
// needs a signed-in server to exist at all, so it can't be the home for
// client-side local folders and SMB shares. Both are reachable; they answer
// different questions.

import SwiftUI
import MapleCore
import UniformTypeIdentifiers

struct LibrarySourcesSettingsView: View {

    @State private var folders: [SavedFolder] = []
    @State private var shares: [SMBCredentialStore.SavedShare] = []
    @State private var registry = CloudServerRegistry.shared

    @State private var showFolderPicker = false
    @State private var showSMBSheet = false
    @State private var errorText: String?

    var body: some View {
        Form {
            foldersSection
            sharesSection
            serversSection
            footerSection
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .task { await refresh() }
        .fileImporter(isPresented: $showFolderPicker,
                      allowedContentTypes: [.folder]) { (result: Result<URL, Error>) in
            // Explicit `Result<URL, Error>` annotation is load-bearing, not
            // stylistic — see the same note on `AppShell`'s importer: without
            // it this call site resolves to a different `.fileImporter`
            // overload on macOS than on iOS.
            guard case .success(let url) = result else { return }
            Task { await addFolder(url) }
        }
        .sheet(isPresented: $showSMBSheet) {
            SMBPickerSheet(
                onConnect: { credentials in
                    showSMBSheet = false
                    Task { await addShare(credentials) }
                },
                onCancel: { showSMBSheet = false }
            )
        }
    }

    // MARK: - Sections

    private var foldersSection: some View {
        Section {
            if folders.isEmpty {
                Text(LibrarySourcesVM.noFoldersCopy)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("librarySources.folders.empty")
            }
            ForEach(folders) { folder in
                sourceRow(
                    title: folder.displayName,
                    subtitle: LibrarySourcesVM.folderSubtitle(folder),
                    identifier: "librarySources.folder.\(folder.path)",
                    onRemove: {
                        SavedFolderStore.remove(path: folder.path)
                        folders = SavedFolderStore.load()
                    }
                )
            }
            Button("Add Folder…") { showFolderPicker = true }
                .accessibilityIdentifier("librarySources.addFolder")
        } header: {
            Text("Local Folders")
        }
        .listRowBackground(MapleTokens.surface)
    }

    private var sharesSection: some View {
        Section {
            if shares.isEmpty {
                Text(LibrarySourcesVM.noSharesCopy)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("librarySources.shares.empty")
            }
            ForEach(shares, id: \.self) { share in
                sourceRow(
                    title: LibrarySourcesVM.shareTitle(share),
                    subtitle: LibrarySourcesVM.shareSubtitle(share),
                    identifier: "librarySources.share.\(share.host).\(share.share)",
                    onRemove: {
                        Task {
                            await SMBCredentialStore.shared.delete(share)
                            shares = await SMBCredentialStore.shared.savedShares()
                        }
                    }
                )
            }
            Button("Add SMB Share…") { showSMBSheet = true }
                .accessibilityIdentifier("librarySources.addShare")
        } header: {
            Text("Network (SMB)")
        }
        .listRowBackground(MapleTokens.surface)
    }

    /// Cloud servers are listed read-only. Registering and signing in
    /// already has a home (Settings → Cloud) and per-root connection status
    /// already has one (server admin → Sources, #2898); duplicating either
    /// here would give the same action two owners. What this section adds is
    /// the answer to "is a Maple server one of my sources?" in the one place
    /// that enumerates every source kind.
    private var serversSection: some View {
        Section {
            if registry.servers.isEmpty {
                Text(LibrarySourcesVM.noServersCopy)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("librarySources.servers.empty")
            }
            ForEach(registry.servers, id: \.self) { url in
                VStack(alignment: .leading, spacing: 2) {
                    Text(LibrarySourcesVM.serverTitle(
                        displayName: registry.displayName(for: url), url: url
                    ))
                    Text(url.absoluteString)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .accessibilityIdentifier("librarySources.server.\(url.absoluteString)")
            }
        } header: {
            Text("Maple Servers")
        }
        .listRowBackground(MapleTokens.surface)
    }

    private var footerSection: some View {
        Section {
            if let errorText {
                Text(errorText)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("librarySources.error")
            }
        } footer: {
            Text(LibrarySourcesVM.pageFooter)
        }
        .listRowBackground(MapleTokens.surface)
    }

    // MARK: - Rows

    private func sourceRow(
        title: String,
        subtitle: String,
        identifier: String,
        onRemove: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(subtitle)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Button(role: .destructive, action: onRemove) {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Remove \(title)")
        }
        .accessibilityIdentifier(identifier)
    }

    // MARK: - Mutations

    private func refresh() async {
        folders = SavedFolderStore.load()
        shares = await SMBCredentialStore.shared.savedShares()
    }

    /// Register a picked folder WITHOUT opening it in the grid. The sidebar
    /// picks it up from `SavedFolderStore.changedNotification`. Resolving a
    /// persistable bookmark is the whole job here: a path alone is useless
    /// to a sandboxed read on the next launch, which is why this mirrors
    /// `AppShell.loadFolder`'s open-then-bookmark step rather than writing
    /// a `SavedFolder` straight from the picker URL.
    private func addFolder(_ url: URL) async {
        guard !LibrarySourcesVM.isAlreadySaved(path: url.path, in: folders) else {
            errorText = "\(url.lastPathComponent) is already one of your sources."
            return
        }
        let source = FilesystemSource()
        do {
            try await source.open(folderURL: url)
            guard let bookmark = await source.persistableBookmark else {
                errorText = "Couldn't keep access to \(url.lastPathComponent). Try picking it again."
                return
            }
            SavedFolderStore.upsert(SavedFolder(
                path: url.path,
                displayName: url.lastPathComponent,
                bookmark: bookmark,
                lastOpened: Date()
            ))
            folders = SavedFolderStore.load()
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
    }

    /// Connect BEFORE saving, unlike `AppShell.connectSMB` which saves first
    /// so a failed connect still leaves a re-try-able entry in the sidebar.
    /// The trade is deliberate: this page's list IS the registration, so a
    /// share that never connected would sit here looking registered.
    private func addShare(_ credentials: SMBSource.Credentials) async {
        do {
            try await SMBSource().connect(credentials: credentials, remotePath: "/")
            try await SMBCredentialStore.shared.save(credentials)
            shares = await SMBCredentialStore.shared.savedShares()
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
    }
}
