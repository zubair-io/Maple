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
    /// One `AuthSession` per Self-Hosted server URL. Lazily created by
    /// `session(for:)` and shared across views via `.environment(_:)`.
    /// Plan 2026-04-28-passkey-auth Task B8.
    @State private var sessions: [URL: AuthSession] = [:]

    init() {
        Self.installMemoryPressureObserver()

        #if DEBUG
        // Note: the Plan 1 AgX-kernel load assertion was retired when the
        // Rust FFI's `apply_scene_linear_chain` subsumed AgX (the Apple
        // Metal AgX kernel was deleted alongside the other 8 cheap-stage
        // kernels). The view transform now lives entirely on the Rust
        // path; if it fails to apply, the FFI returns an error rather
        // than a silent no-op.

        // UITest harness hook. The test driver launches the app with
        // `MAPLE_UITEST_FIXTURE=<basename>` (resolved against
        // `MAPLE_UITEST_FIXTURE_ROOT`, defaulting to the repo's
        // `test-fixtures/raws/`). AppShell consumes this on `.task`,
        // calls `BrowseViewModel.loadSingleAsset(url:)`, and auto-flips
        // into Full-image mode so the harness skips picker / folder
        // navigation. Spike A (2026-04-25) confirmed env vars survive
        // the macOS sandbox. See
        // docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md.
        if let fixture = ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE"],
           !fixture.isEmpty {
            let root = ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE_ROOT"]
                ?? Self.defaultFixtureRoot()
            let url = URL(fileURLWithPath: root)
                .appendingPathComponent(fixture)
            if FileManager.default.fileExists(atPath: url.path) {
                MapleApp.uitestFixtureURL = url
            }
        }
        #endif
    }

    #if DEBUG
    /// Stashed by `init()` when `MAPLE_UITEST_FIXTURE` resolves to an
    /// existing file. AppShell consumes via `.task` on the macOS shell.
    /// Nil in production (the env var is read inside `#if DEBUG`).
    nonisolated(unsafe) static var uitestFixtureURL: URL?

    /// Best-effort default for `MAPLE_UITEST_FIXTURE_ROOT`. Used only when
    /// the env var is unset; matches the layout the harness expects. The
    /// path walks up from the running app bundle to the repo root, but a
    /// CI runner with the test bundle elsewhere will set the env var
    /// explicitly per `xcodebuild test … MAPLE_UITEST_FIXTURE_ROOT=…`.
    private static func defaultFixtureRoot() -> String {
        // CWD when xcodebuild test launches Maple.app on macOS is
        // typically the working directory of the xcodebuild invocation,
        // but we don't rely on that — fall back to a path the harness
        // can override.
        return FileManager.default.currentDirectoryPath + "/test-fixtures/raws"
    }
    #endif

    /// Returns the `AuthSession` for `server`, creating + bootstrapping one
    /// (token restore via Keychain) on first request. Cached per URL so the
    /// shell, sign-in view, and account/admin views all observe the same
    /// session state.
    @MainActor
    private func session(for server: URL) -> AuthSession {
        if let s = sessions[server] { return s }
        let client = AuthClient(server: server)
        let s = AuthSession(server: server, client: client)
        sessions[server] = s
        Task { await s.bootstrapAndRestore() }
        return s
    }

    var body: some Scene {
        WindowGroup {
            AppShell(sessionFor: { server in session(for: server) })
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
/// `AddMapleCloudSheet` or remove existing ones.
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
            AddMapleCloudSheet(
                onDismiss: { showAddSheet = false },
                onSignedIn: { url, tokens, _ in
                    Task { @MainActor in
                        try? TokenStore.save(tokens, server: url)
                        try? await SelfHostedCredentialStore.shared
                            .setToken(tokens.access, forServerURL: url)
                        showAddSheet = false
                        await refresh()
                    }
                }
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
