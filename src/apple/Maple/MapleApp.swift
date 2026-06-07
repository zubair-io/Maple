// MapleApp.swift — Entry point: SwiftUI App with three-column shell.
//
// Mac/iPad: NavigationSplitView (AppShell).
// iPhone: TabView collapse in AppShell.

import SwiftUI
import CoreText
import MapleCore
import MapleBackup
import OSLog
#if canImport(UIKit)
import UIKit
#endif

private let signInLog = Logger(subsystem: "app.justmaple.aperture", category: "signin")

@main
struct MapleApp: App {
    /// One `AuthSession` per Self-Hosted server URL. Lazily created by
    /// `session(for:)` and shared across views via `.environment(_:)`.
    /// Plan 2026-04-28-passkey-auth Task B8.
    @State private var sessions: [URL: AuthSession] = [:]
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Self.registerBundledFonts()
        Self.installMemoryPressureObserver()
        BGTaskRegistration.register()

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
        // .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md.
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
            #if MAPLE_GPU
            // GPU validation harness (#988), OFF in every shipping/CI build —
            // the whole branch only compiles when the `MAPLE_GPU` flag is set
            // (the gpu-variant validation build). Launch with
            // `MAPLE_GPU_DEBUG=1` to replace the shell with the wgpu/Metal
            // proof screen (parity readout + CAMetalLayer passthrough). Reuses
            // the same launch-environment pattern as the UITest fixture hook.
            if ProcessInfo.processInfo.environment["MAPLE_GPU_DEBUG"] == "1" {
                GpuDebugView()
            } else {
                appShell
            }
            #else
            appShell
            #endif
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

    /// The normal app shell, extracted so the `#if MAPLE_GPU` debug-view branch
    /// in `body` can fall back to it without duplicating the modifier chain.
    @ViewBuilder
    private var appShell: some View {
        AppShell(sessionFor: { server in session(for: server) })
                .onOpenURL { url in
                    // `maple://image/{id}` and `maple://source/{id}` —
                    // routed by the AppShell `.task` after
                    // `restoreLastSource()` (cold start) and by an
                    // `.onChange(of: DeepLinkRouter.shared.pendingDestination)`
                    // observer (warm launch). Spec: docs/design/responsive-program/deep-links.md.
                    DeepLinkRouter.shared.handle(url)
                }
                .task {
                    // Start telemetry first: reads the disk-cached SigNoz
                    // config and bootstraps swift-otel synchronously (no
                    // network), then background-refreshes. Never blocks launch.
                    // Ticket #713.
                    ObservabilityController.shared.start()
                }
                .task {
                    guard let settings = BackupSettings.load(), settings.isConfigured,
                          let serverBaseURL = URL(string: settings.serverURL) else { return }
                    await EngineHost.shared.start(settings: settings)
                    // Use the same DeviceIdentity the engine just resolved.
                    if let storage = try? DeviceIdentity.defaultStorageURL(),
                       let deviceId = try? DeviceIdentity.current(storageURL: storage) {
                        ChangeObserverWiring.start(deviceId: deviceId, settings: settings,
                                                   libraryId: settings.libraryId,
                                                   serverBaseURL: serverBaseURL)
                    }
                }
                .onChange(of: scenePhase) { _, newPhase in
                    if newPhase == .background {
                        BGTaskRegistration.schedule()
                    }
                    #if os(iOS)
                    if newPhase == .active {
                        // Re-foreground: signal every active File Provider
                        // domain so the next Files-app refresh sees fresh
                        // server state. Best-effort; failures surface only
                        // in the in-app status banner. Model construction
                        // is cheap — it just wraps a stateless controller.
                        Task { await FileProviderSettingsModel().refreshAll() }
                    }
                    #endif
                }
    }

    /// Register bundled .ttf font faces with the OS so `Font.custom("…", size:)`
    /// resolves them. `INFOPLIST_KEY_UIAppFonts` exists in build settings (and
    /// is the spec's preferred path on iOS), but the Info.plist synthesizer
    /// for this Xcode/SDK pair does not emit the key into the built plist —
    /// the synthesizer recognizes only a fixed allowlist of `INFOPLIST_KEY_*`
    /// names and `UIAppFonts` is not on it as of Xcode 17 / SDK 26.4. macOS
    /// never had a synthesizer-supported font-registration key.
    ///
    /// Core Text registration sidesteps the plist path entirely and works on
    /// both platforms. `CTFontManagerRegisterFontsForURL` is idempotent per
    /// process; the error pointer is intentionally nil — we silently skip
    /// duplicate registrations.
    ///
    /// Files live under `Maple/Resources/Fonts/` in source; the filesystem-
    /// synchronized group flattens those into `Contents/Resources/` at build
    /// time, so the bundle lookup uses bare filenames.
    private static func registerBundledFonts() {
        let names = ["Lato-Regular", "Lato-Bold", "Merriweather-Bold"]
        for name in names {
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else {
                continue
            }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
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

// MARK: - SettingsView (cross-platform)

struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettingsTab()
                .tabItem { Label("General", systemImage: "gear") }
            BackupSettingsView()
                .tabItem { Label("Backup", systemImage: "icloud.and.arrow.up") }
            SelfHostedSettingsTab()
                .tabItem { Label("Self Hosted", systemImage: "cloud") }
            ObservabilitySettingsTab()
                .tabItem { Label("Observability", systemImage: "waveform.path.ecg") }
            #if os(macOS)
            FileProviderSettingsView()
                .tabItem { Label("Finder", systemImage: "folder") }
            #elseif os(iOS)
            FileProviderSettingsViewIOS()
                .tabItem { Label("Files", systemImage: "folder") }
            #endif
        }
        #if os(macOS)
        .frame(width: 520, height: 460)
        #endif
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

/// Maple Cloud server management. Lists registered servers (CloudServerRegistry)
/// and lets the user add new ones via `AddMapleCloudSheet` or remove existing
/// ones.
private struct SelfHostedSettingsTab: View {
    @State private var registry = CloudServerRegistry.shared
    @State private var showAddSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Maple Cloud Servers")
                .font(.headline)

            if registry.servers.isEmpty {
                VStack(spacing: 6) {
                    Text("No paired servers.")
                        .foregroundStyle(.secondary)
                    Text("Click \"Add Server…\" to pair a Maple Cloud instance.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            } else {
                List {
                    ForEach(registry.servers, id: \.self) { url in
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
                                registry.remove(url)
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
        .sheet(isPresented: $showAddSheet) {
            AddMapleCloudSheet(
                onDismiss: { showAddSheet = false },
                onSignedIn: { url, tokens, _ in
                    Task { @MainActor in
                        // Don't swallow a save failure: if the token can't be
                        // persisted the app silently keeps using whatever was
                        // stored before (e.g. a stale token from before a
                        // server rebuild), which surfaces as "bad signature"
                        // 401s with no obvious cause.
                        do {
                            try TokenStore.save(tokens, server: url)
                        } catch {
                            signInLog.error("failed to persist tokens for \(url.absoluteString, privacy: .public): \(error.localizedDescription, privacy: .public)")
                        }
                        registry.register(url)
                        showAddSheet = false
                    }
                }
            )
        }
    }
}
