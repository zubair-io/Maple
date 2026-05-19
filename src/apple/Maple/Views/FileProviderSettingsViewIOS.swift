// src/apple/Maple/Views/FileProviderSettingsViewIOS.swift
#if os(iOS)
import SwiftUI
import MapleCore
import UIKit
import UniformTypeIdentifiers

struct FileProviderSettingsViewIOS: View {
    @State private var model = FileProviderSettingsModel()
    @State private var registry = CloudServerRegistry.shared
    /// Pending grant target — when set, the document-picker sheet is
    /// presented for that server's FP mount URL. Carries both the server
    /// URL (for `persistGrantedBookmark`) and the pre-resolved mount root
    /// (for the picker's `directoryURL` and the within-mount safety check).
    @State private var pendingGrant: PendingGrant? = nil

    private struct PendingGrant: Identifiable {
        let id = UUID()
        let serverURL: URL
        let mountURL: URL
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if registry.servers.isEmpty {
                        Text("No Maple servers paired. Add one from the Self Hosted tab.")
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
                    Text("Enabling a server mounts its photo library under Locations in the Files app. Originals stay on the server; files download on first tap.")
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
            .navigationTitle("Files")
            .task { await model.reload() }
            .sheet(item: $pendingGrant) { grant in
                DocumentFolderPicker(
                    directoryURL: grant.mountURL,
                    onPick: { picked in
                        model.persistGrantedBookmark(
                            serverURL: grant.serverURL,
                            picked: picked,
                            mountURL: grant.mountURL
                        )
                        pendingGrant = nil
                    },
                    onCancel: { pendingGrant = nil }
                )
                .ignoresSafeArea()
            }
        }
    }

    @ViewBuilder
    private func serverRow(url: URL) -> some View {
        let host = url.host ?? url.absoluteString
        let displayName = registry.displayName(for: url) ?? host
        let enabled = model.isEnabled(url)
        let domainID = FileProviderDomainController.domainIdentifier(for: url)
        let busy = domainID.map { model.inFlightDomains.contains($0) } ?? false

        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName)
                    Text(host)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if enabled {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
            }
            if enabled {
                HStack(spacing: 12) {
                    Button("Open in Files") {
                        Task { await model.openInFiles(url) }
                    }
                    .accessibilityIdentifier("file-provider-open-\(domainID ?? host)")

                    Button("Refresh") { Task { await model.refresh(url) } }
                        .accessibilityIdentifier("file-provider-refresh-\(domainID ?? host)")
                    Button("Disable", role: .destructive) {
                        Task { await model.disable(url) }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("file-provider-disable-\(domainID ?? host)")
                }
                .buttonStyle(.bordered)

                if model.isSynced(url) {
                    HStack(spacing: 6) {
                        Text("Synced ✓")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("file-provider-synced-\(domainID ?? host)")
                        Button("Revoke") {
                            model.revokeSyncedFolderAccess(url)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("file-provider-revoke-\(domainID ?? host)")
                    }
                } else {
                    Button("Use synced folder for fast access") {
                        Task { await startGrant(for: url) }
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("file-provider-grant-\(domainID ?? host)")
                }
            } else {
                HStack(spacing: 12) {
                    Button("Enable in Files") {
                        Task { await model.enable(serverURL: url, displayName: displayName) }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("file-provider-enable-\(domainID ?? host)")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }

    /// Resolve the FP mount root for `serverURL`, then trigger the
    /// document-picker sheet pointed at it. Mirrors the macOS
    /// `grantSyncedFolderAccess` async pre-flight (fetch mount URL,
    /// surface a status message on failure) but defers the actual UI to
    /// the sheet so SwiftUI controls presentation rather than us spinning
    /// up a UIViewController imperatively.
    @MainActor
    private func startGrant(for serverURL: URL) async {
        do {
            guard let mountURL = try await model.mountURL(for: serverURL) else {
                model.statusMessage = "Grant failed: domain not registered"
                return
            }
            pendingGrant = PendingGrant(serverURL: serverURL, mountURL: mountURL)
        } catch {
            model.statusMessage = "Grant failed: \(error.localizedDescription)"
        }
    }
}

// MARK: - DocumentFolderPicker

/// Thin SwiftUI wrapper around `UIDocumentPickerViewController` configured
/// for folder selection. The folder picker is the only iOS entry point
/// for capturing a security-scoped URL the app can later resolve from a
/// persisted bookmark — `UIApplication.shared.open` against
/// `shareddocuments://` doesn't return a usable URL to us.
private struct DocumentFolderPicker: UIViewControllerRepresentable {
    let directoryURL: URL
    let onPick: (URL) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        picker.directoryURL = directoryURL
        picker.allowsMultipleSelection = false
        picker.shouldShowFileExtensions = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {
        // No-op: the picker's configuration is set once at creation; the
        // pendingGrant binding controls show/dismiss via SwiftUI's sheet.
    }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: (URL) -> Void
        let onCancel: () -> Void

        init(onPick: @escaping (URL) -> Void, onCancel: @escaping () -> Void) {
            self.onPick = onPick
            self.onCancel = onCancel
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard let url = urls.first else { onCancel(); return }
            onPick(url)
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            onCancel()
        }
    }
}
#endif
