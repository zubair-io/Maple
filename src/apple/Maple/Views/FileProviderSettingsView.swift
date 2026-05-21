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
    private let controller = FileProviderDomainController()

    func reload() async {
        do { domains = try await controller.currentDomains() }
        catch { statusMessage = "Couldn't list domains: \(error.localizedDescription)" }
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

// MARK: - Previews
//
// Issue #139 — macOS-only File Provider settings. The view reads from
// `CloudServerRegistry.shared`, which in a clean preview environment
// has no servers paired — that exercises the empty-state branch.

#Preview("Default — no servers") {
    FileProviderSettingsView()
        .frame(width: 480, height: 320)
}
#endif
