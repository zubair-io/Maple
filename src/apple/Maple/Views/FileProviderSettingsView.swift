// src/apple/Maple/Views/FileProviderSettingsView.swift
import SwiftUI
import MapleCore
import FileProvider

@MainActor
@Observable
final class FileProviderSettingsModel {
    /// Active File Provider domains.
    var domains: [NSFileProviderDomain] = []
    var statusMessage: String? = nil
    /// Domain identifiers with an in-flight enable/disable.
    var inFlightDomains: Set<String> = []
    /// Domain identifiers with a persisted mount bookmark (Synced ✓).
    var syncedDomains: Set<String> = []
    private let controller = FileProviderDomainController()

    func reload() async {
        do { domains = try await controller.currentDomains() }
        catch { statusMessage = "Couldn't list domains: \(error.localizedDescription)" }
        refreshBookmarkState()
    }

    /// Re-read the App Group UserDefaults for which domains currently
    /// have a persisted security-scoped bookmark. Cheap; called after
    /// any mutation to the bookmark store.
    ///
    /// Fetches `defaultDefaults` once and passes it down the loop —
    /// otherwise the default-parameter pattern on `load(domain:)`
    /// rebuilds `UserDefaults(suiteName:)` on every iteration.
    func refreshBookmarkState() {
        let defaults = FileProviderMountBookmark.defaultDefaults
        var synced: Set<String> = []
        for d in domains {
            let id = d.identifier.rawValue
            if FileProviderMountBookmark.load(domain: id, defaults: defaults) != nil {
                synced.insert(id)
            }
        }
        syncedDomains = synced
    }

    func isSynced(_ url: URL) -> Bool {
        guard let id = FileProviderDomainController.domainIdentifier(for: url) else { return false }
        return syncedDomains.contains(id)
    }

    func isEnabled(_ url: URL) -> Bool {
        guard let id = FileProviderDomainController.domainIdentifier(for: url) else { return false }
        return domains.contains { $0.identifier.rawValue == id }
    }

    func enable(serverURL: URL, displayName: String) async {
        guard let id = FileProviderDomainController.domainIdentifier(for: serverURL),
              !inFlightDomains.contains(id) else { return }
        inFlightDomains.insert(id)
        defer { inFlightDomains.remove(id) }
        do {
            _ = try await controller.enable(serverURL: serverURL, displayName: displayName)
            statusMessage = "Enabled \(displayName)"
            await reload()
        } catch {
            statusMessage = "Enable failed: \(error.localizedDescription)"
        }
    }

    func disable(_ url: URL) async {
        guard let id = FileProviderDomainController.domainIdentifier(for: url),
              !inFlightDomains.contains(id) else { return }
        inFlightDomains.insert(id)
        defer { inFlightDomains.remove(id) }
        do {
            try await controller.disable(domainIdentifier: id)
            statusMessage = "Disabled"
            await reload()
        } catch {
            statusMessage = "Disable failed: \(error.localizedDescription)"
        }
    }

    func refresh(_ url: URL) async {
        guard let id = FileProviderDomainController.domainIdentifier(for: url) else { return }
        do { try await controller.refresh(domainIdentifier: id) }
        catch { statusMessage = "Refresh failed: \(error.localizedDescription)" }
    }

    #if os(macOS)
    /// Reveal the mounted File Provider root in Finder. Uses
    /// `getUserVisibleURL(for: .rootContainer)` so the path is whatever
    /// the OS chose (typically `~/Library/CloudStorage/<DisplayName>/`).
    /// The console may emit sandbox-extension warnings — they're
    /// cosmetic; LaunchServices opens the folder regardless.
    func openInFinder(_ url: URL) async {
        guard let id = FileProviderDomainController.domainIdentifier(for: url) else { return }
        guard let domain = domains.first(where: { $0.identifier.rawValue == id }),
              let mgr = NSFileProviderManager(for: domain) else {
            statusMessage = "Open in Finder failed: domain not registered"
            return
        }
        do {
            let visibleURL = try await mgr.getUserVisibleURL(for: .rootContainer)
            NSWorkspace.shared.activateFileViewerSelecting([visibleURL])
        } catch {
            statusMessage = "Open in Finder failed: \(error.localizedDescription)"
        }
    }

    /// Prompt the user via NSOpenPanel for access to the FP mount root,
    /// then persist the resulting security-scoped bookmark via
    /// `FileProviderMountBookmark`. The bookmark itself is not consumed
    /// yet — that's a follow-up (#101). This call only establishes the
    /// grant and surfaces "Synced ✓" in the UI.
    func grantSyncedFolderAccess(_ url: URL) async {
        guard let id = FileProviderDomainController.domainIdentifier(for: url) else { return }
        guard let domain = domains.first(where: { $0.identifier.rawValue == id }),
              let mgr = NSFileProviderManager(for: domain) else {
            statusMessage = "Grant failed: domain not registered"
            return
        }
        let mountURL: URL
        do {
            mountURL = try await mgr.getUserVisibleURL(for: .rootContainer)
        } catch {
            statusMessage = "Grant failed: \(error.localizedDescription)"
            return
        }

        let panel = NSOpenPanel()
        panel.message = "Grant Maple access to the synced folder."
        panel.prompt = "Allow"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = mountURL

        let response = await panel.begin()
        guard response == .OK, let chosen = panel.url else { return }

        // The user can navigate away from the pre-pointed mount inside
        // NSOpenPanel and pick a completely unrelated folder. Persisting
        // that as the FP-mount bookmark would silently lie ("Synced ✓"
        // for a directory the FP extension never touches). Accept the
        // exact mount URL or any subdirectory of it; reject anything
        // else with a user-visible alert.
        guard Self.isURL(chosen, withinMount: mountURL) else {
            let alert = NSAlert()
            alert.messageText = "Wrong folder"
            alert.informativeText = "Please select the synced folder Maple opened for you (\(mountURL.lastPathComponent))."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            alert.runModal()
            statusMessage = "Grant cancelled — selected folder is outside the synced mount."
            return
        }

        do {
            let bookmark = try chosen.bookmarkData(
                options: .withSecurityScope,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            FileProviderMountBookmark.save(bookmark, domain: id)
            refreshBookmarkState()
            statusMessage = "Synced folder access granted."
        } catch {
            statusMessage = "Bookmark failed: \(error.localizedDescription)"
        }
    }

    /// Returns true when `candidate` is the same directory as `mount`
    /// or a descendant of it. Both URLs are resolved/standardised first
    /// to compare without symlink or `..` noise.
    static func isURL(_ candidate: URL, withinMount mount: URL) -> Bool {
        let cPath = candidate.resolvingSymlinksInPath().standardizedFileURL.path
        let mPath = mount.resolvingSymlinksInPath().standardizedFileURL.path
        if cPath == mPath { return true }
        let prefix = mPath.hasSuffix("/") ? mPath : mPath + "/"
        return cPath.hasPrefix(prefix)
    }

    /// Clear a previously-granted bookmark. The user can re-grant later
    /// via the "Use synced folder" button.
    func revokeSyncedFolderAccess(_ url: URL) {
        guard let id = FileProviderDomainController.domainIdentifier(for: url) else { return }
        FileProviderMountBookmark.remove(domain: id)
        refreshBookmarkState()
        statusMessage = "Synced folder access revoked."
    }
    #endif

    /// Refresh every active domain. Called from the iOS `scenePhase` hook
    /// on foreground entry so re-opening the app surfaces fresh server
    /// state on the next Files-app refresh cycle.
    func refreshAll() async {
        await reload()
        for d in domains {
            do { try await controller.refresh(domainIdentifier: d.identifier.rawValue) }
            catch {
                statusMessage = "Refresh failed for \(d.displayName): \(error.localizedDescription)"
            }
        }
    }
}

#if os(macOS)
struct FileProviderSettingsView: View {
    @State private var model = FileProviderSettingsModel()
    @State private var registry = CloudServerRegistry.shared

    var body: some View {
        Form {
            Section {
                if registry.servers.isEmpty {
                    Text("No Maple servers paired. Switch to the Self Hosted tab to add one.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("file-provider-no-servers")
                } else {
                    ForEach(registry.servers, id: \.absoluteString) { url in
                        serverRow(url: url)
                    }
                }
            } header: {
                Text("Maple servers")
            } footer: {
                Text("Enabling a server in Finder mounts its photo library under Locations. Originals stay on the server; files download on first access.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let msg = model.statusMessage {
                Section {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("file-provider-status")
                }
            }
        }
        .formStyle(.grouped)
        .task { await model.reload() }
    }

    @ViewBuilder
    private func serverRow(url: URL) -> some View {
        let host = url.host ?? url.absoluteString
        let displayName = registry.displayName(for: url) ?? host
        let enabled = model.isEnabled(url)
        let domainID = FileProviderDomainController.domainIdentifier(for: url)
        let busy = domainID.map { model.inFlightDomains.contains($0) } ?? false

        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName)
                Text(host)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if enabled {
                Button("Open in Finder") {
                    Task { await model.openInFinder(url) }
                }
                .accessibilityIdentifier("file-provider-open-\(domainID ?? host)")

                if model.isSynced(url) {
                    HStack(spacing: 6) {
                        Text("Synced ✓")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("file-provider-synced-\(domainID ?? host)")
                        Button("Revoke") {
                            model.revokeSyncedFolderAccess(url)
                        }
                        .buttonStyle(.link)
                        .accessibilityIdentifier("file-provider-revoke-\(domainID ?? host)")
                    }
                } else {
                    Button("Use synced folder for fast access") {
                        Task { await model.grantSyncedFolderAccess(url) }
                    }
                    .help("One-time permission grant lets Maple read directly from the synced folder instead of through the server.")
                    .accessibilityIdentifier("file-provider-grant-\(domainID ?? host)")
                }

                Button("Refresh") {
                    Task { await model.refresh(url) }
                }
                .accessibilityIdentifier("file-provider-refresh-\(domainID ?? host)")
                Button("Disable", role: .destructive) {
                    Task { await model.disable(url) }
                }
                .disabled(busy)
                .accessibilityIdentifier("file-provider-disable-\(domainID ?? host)")
            } else {
                Button("Enable in Finder") {
                    Task { await model.enable(serverURL: url, displayName: displayName) }
                }
                .disabled(busy)
                .accessibilityIdentifier("file-provider-enable-\(domainID ?? host)")
            }
        }
    }
}
#endif
