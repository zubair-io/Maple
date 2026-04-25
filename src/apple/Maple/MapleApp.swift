// MapleApp.swift — Entry point: SwiftUI App with three-column shell.
//
// Mac/iPad: NavigationSplitView (AppShell).
// iPhone: TabView collapse in AppShell.

import SwiftUI
import MapleCore
#if canImport(UIKit)
import UIKit
#endif

@main
struct MapleApp: App {
    init() {
        Self.installMemoryPressureObserver()

        #if DEBUG
        // Plan 1 regression net: if the AgX metallib doesn't load, we'll
        // display raw scene-linear data on the new path. Catch at app
        // launch, not at first-pixel-displayed. See
        // docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md Task 4
        // Step 4.0a.
        assert(MapleCore.MetalKernels.agxKernel() != nil,
            "AgX Metal kernel failed to load — view transform will silently no-op on the scene-linear path. Verify AgXViewTransform.metal is in the Metal sources for this build target.")
        #endif
    }

    var body: some Scene {
        WindowGroup {
            AppShell()
        }
        #if os(macOS)
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: true))
        .defaultSize(width: 1280, height: 800)
        #endif

        #if os(macOS)
        // Settings scene. Self-Hosted server management lives here — the
        // sidebar only shows Self Hosted once at least one server is paired.
        Settings {
            SettingsView()
        }
        #endif
    }

    /// Forward memory-pressure / low-memory signals to the thumbnail loader so
    /// it drops hot in-memory entries before the OS jettisons us. On macOS,
    /// `DispatchSource.makeMemoryPressureSource` fires at warn/critical; on
    /// iOS, `UIApplication.didReceiveMemoryWarningNotification`.
    private static func installMemoryPressureObserver() {
        #if os(macOS)
        let src = DispatchSource.makeMemoryPressureSource(
            eventMask: [.warning, .critical],
            queue: .global(qos: .utility)
        )
        src.setEventHandler {
            Task { await ThumbnailLoader.shared.handleMemoryPressure() }
        }
        src.resume()
        // Keep the source alive for the app lifetime — stash on a throwaway
        // static so ARC doesn't deallocate it.
        _memoryPressureSource = src
        #elseif canImport(UIKit)
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { _ in
            Task { await ThumbnailLoader.shared.handleMemoryPressure() }
        }
        #endif
    }
}

#if os(macOS)
private nonisolated(unsafe) var _memoryPressureSource: DispatchSourceMemoryPressure?
#endif

// MARK: - SettingsView (macOS)

#if os(macOS)
struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettingsTab()
                .tabItem { Label("General", systemImage: "gear") }
            SelfHostedSettingsTab()
                .tabItem { Label("Self Hosted", systemImage: "cloud") }
        }
        .frame(width: 520, height: 360)
    }
}

private struct GeneralSettingsTab: View {
    var body: some View {
        Form {
            LabeledContent("Version") {
                Text(MapleCore.version())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(24)
    }
}

/// Self-Hosted server management. Lists paired servers (from Keychain +
/// `knownServers()`) and lets the user add new ones via
/// `SelfHostedPickerSheet` or remove existing ones.
private struct SelfHostedSettingsTab: View {
    @State private var servers: [URL] = []
    @State private var showAddSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Paired Servers")
                .font(.headline)

            if servers.isEmpty {
                VStack(spacing: 6) {
                    Text("No paired servers.")
                        .foregroundStyle(.secondary)
                    Text("Click \"Add Server…\" to pair a Maple Self Hosted instance.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            } else {
                List {
                    ForEach(servers, id: \.self) { url in
                        HStack {
                            Image(systemName: "server.rack")
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(url.host ?? url.absoluteString)
                                Text(url.absoluteString)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(role: .destructive) {
                                Task { await removeServer(url) }
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.red)
                        }
                        .padding(.vertical, 2)
                    }
                }
                .listStyle(.inset)
                .frame(minHeight: 120)
            }

            Spacer()

            HStack {
                Spacer()
                Button("Add Server…") { showAddSheet = true }
                    .keyboardShortcut("n", modifiers: .command)
            }
        }
        .padding(24)
        .task { await refresh() }
        .sheet(isPresented: $showAddSheet) {
            SelfHostedPickerSheet(
                onConnect: { _, _ in
                    showAddSheet = false
                    Task { await refresh() }
                },
                onCancel: { showAddSheet = false }
            )
        }
    }

    @MainActor
    private func refresh() async {
        servers = await SelfHostedCredentialStore.shared.knownServers()
    }

    @MainActor
    private func removeServer(_ url: URL) async {
        try? await SelfHostedCredentialStore.shared.removeToken(forServerURL: url)
        await refresh()
    }
}
#endif
