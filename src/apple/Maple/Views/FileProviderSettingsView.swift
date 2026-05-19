// src/apple/Maple/Views/FileProviderSettingsView.swift
import SwiftUI
import MapleCore
import FileProvider
#if os(iOS)
import UIKit
#endif

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

    /// Cross-platform helper: resolve the user-visible mount root URL for
    /// a server's File Provider domain (typically
    /// `~/Library/CloudStorage/<DisplayName>/` on macOS or the
    /// OS-managed Files-app location on iOS). Returns `nil` when the
    /// domain isn't registered or `NSFileProviderManager(for:)` can't
    /// construct a manager; throws when `getUserVisibleURL` itself fails.
    func mountURL(for url: URL) async throws -> URL? {
        guard let id = FileProviderDomainController.domainIdentifier(for: url),
              let domain = domains.first(where: { $0.identifier.rawValue == id }),
              let mgr = NSFileProviderManager(for: domain) else {
            return nil
        }
        return try await mgr.getUserVisibleURL(for: .rootContainer)
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
    /// via the "Use synced folder" button (macOS) or the document picker
    /// flow on iOS.
    func revokeSyncedFolderAccess(_ url: URL) {
        guard let id = FileProviderDomainController.domainIdentifier(for: url) else { return }
        FileProviderMountBookmark.remove(domain: id)
        refreshBookmarkState()
        statusMessage = "Synced folder access revoked."
    }

    #if os(macOS)
    /// Reveal the mounted File Provider root in Finder. Uses
    /// `getUserVisibleURL(for: .rootContainer)` so the path is whatever
    /// the OS chose (typically `~/Library/CloudStorage/<DisplayName>/`).
    /// The console may emit sandbox-extension warnings — they're
    /// cosmetic; LaunchServices opens the folder regardless.
    func openInFinder(_ url: URL) async {
        do {
            guard let visibleURL = try await mountURL(for: url) else {
                statusMessage = "Open in Finder failed: domain not registered"
                return
            }
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
        let mountURL: URL
        do {
            guard let resolved = try await self.mountURL(for: url) else {
                statusMessage = "Grant failed: domain not registered"
                return
            }
            mountURL = resolved
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
    #endif

    #if os(iOS)
    /// Deep-link into the Files app at the FP mount root. Uses the
    /// `shareddocuments://` scheme — the iOS-documented pattern for
    /// jumping to a Files-app location given a file URL. If `UIApplication`
    /// can't open the URL (e.g. Files app restricted by MDM), the status
    /// banner surfaces the failure rather than silently no-op'ing.
    ///
    /// Caveat: the `shareddocuments://` scheme is not formally documented
    /// by Apple but is the only reliable way to launch Files at a known
    /// folder; if Apple removes it the button degrades to a no-op (the
    /// `open` call returns `false` and we surface a status message).
    @MainActor
    func openInFiles(_ url: URL) async {
        do {
            guard let visibleURL = try await mountURL(for: url) else {
                statusMessage = "Open in Files failed: domain not registered"
                return
            }
            // Decompose the file:// URL and swap the scheme to shareddocuments://.
            // Building URLComponents from scratch produces `shareddocuments:/<path>`
            // (single slash) which Files won't route; copying from the existing
            // file URL preserves the empty-host component so the output is
            // `shareddocuments:///<path>` — the hierarchical form Files expects.
            guard var components = URLComponents(url: visibleURL, resolvingAgainstBaseURL: false) else {
                statusMessage = "Open in Files failed: couldn't decompose mount URL"
                return
            }
            components.scheme = "shareddocuments"
            guard let filesURL = components.url else {
                statusMessage = "Open in Files failed: couldn't build deep-link URL"
                return
            }
            let ok = await UIApplication.shared.open(filesURL)
            if !ok {
                statusMessage = "Open in Files failed: the system couldn't route the URL"
            }
        } catch {
            statusMessage = "Open in Files failed: \(error.localizedDescription)"
        }
    }

    /// Persist a security-scope-free bookmark for the URL the user picked
    /// in `UIDocumentPickerViewController(forOpeningContentTypes: [.folder])`.
    ///
    /// iOS bookmarks don't use the macOS `.withSecurityScope` option flag —
    /// the Files framework's URL handoff carries scope through implicitly.
    /// `FileProviderMountBookmark.resolveURL(domain:)` already gates the
    /// resolution options on `os(macOS)` so resolves correctly here.
    ///
    /// `mountURL` is the pre-resolved FP root we pre-pointed the picker at;
    /// we accept the exact URL or a subdirectory and reject anything else
    /// with a status message (mirrors the macOS NSOpenPanel safety check).
    func persistGrantedBookmark(serverURL: URL, picked: URL, mountURL: URL) {
        guard let id = FileProviderDomainController.domainIdentifier(for: serverURL) else { return }
        guard Self.isURL(picked, withinMount: mountURL) else {
            statusMessage = "Grant cancelled — selected folder is outside the synced mount."
            return
        }
        // iOS folder-picker URLs come back security-scoped; we must call
        // start/stopAccessingSecurityScopedResource around bookmarkData to
        // mint a usable bookmark. If the scope claim fails we'd still
        // mint a bookmark, but the bytes would be unusable when resolved
        // later — surface the failure and bail rather than persist a
        // bookmark that silently doesn't work.
        guard picked.startAccessingSecurityScopedResource() else {
            statusMessage = "Couldn't claim access to the selected folder — please try again."
            return
        }
        defer { picked.stopAccessingSecurityScopedResource() }
        do {
            let bookmark = try picked.bookmarkData(
                options: [],
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
