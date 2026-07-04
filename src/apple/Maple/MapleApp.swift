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
        // #1740 M1 dev A/B — must run BEFORE the first Auto-Profile fit
        // (cold-open develop), so the Rust FFI's `MAPLE_AUTO2` env read sees
        // whichever of the two toggles (env var already present, or the
        // `-MapleAuto2 1` launch argument) selected the structured fit. See
        // Auto2Flag's module doc for why `open -n` needs the launch-argument
        // form.
        Auto2Flag.propagateToProcessEnvironmentIfNeeded()

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
            // GPU validation harness (#988), runtime-gated. Launch with
            // `MAPLE_GPU_DEBUG=1` to replace the shell with the wgpu/Metal
            // proof screen (parity readout + CAMetalLayer passthrough). Reuses
            // the same launch-environment pattern as the UITest fixture hook.
            if ProcessInfo.processInfo.environment["MAPLE_GPU_DEBUG"] == "1" {
                GpuDebugView()
            } else {
                appShell
            }
        }
        #if os(macOS)
        // Full-bleed editor (#4 follow-up): a HIDDEN title bar keeps the macOS
        // traffic-light controls floating over the content, so the editor can
        // hide its toolbar (`.toolbar(.hidden, for: .windowToolbar)` in
        // EditorView) and run edge-to-edge WITHOUT losing the window controls.
        // With the previous `.titleBar` + `.unified` toolbar, hiding the toolbar
        // collapsed the unified title bar and took the traffic lights with it
        // (black strip). Browse still renders its toolbar via AppShellToolbar.
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
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

    /// The normal app shell, extracted so the `MAPLE_GPU_DEBUG` debug-view branch
    /// in `body` can fall back to it without duplicating the modifier chain.
    @ViewBuilder
    private var appShell: some View {
        AppShell(sessionFor: { server in session(for: server) })
                .onOpenURL { url in
                    // File URLs are opened documents ("Open With Maple",
                    // `open -a`, drag-onto-dock) — they arrive with a
                    // LaunchServices security-scope grant the sandboxed FFI
                    // read needs, so route them to `DocumentOpenRouter` (#1589).
                    // Custom-scheme URLs are `maple://image|source/{id}` deep
                    // links — routed by the AppShell `.task` after
                    // `restoreLastSource()` (cold start) and by an
                    // `.onChange(of: DeepLinkRouter.shared.pendingDestination)`
                    // observer (warm launch). Spec: docs/design/responsive-program/deep-links.md.
                    if url.isFileURL {
                        DocumentOpenRouter.shared.handle(url)
                    } else {
                        DeepLinkRouter.shared.handle(url)
                    }
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

/// Tab identifiers for `SettingsView`.  Callers (e.g. `AppShell`) can pass
/// a binding to pre-select a tab — used by the not-provisioned pano error
/// flow so "Configure in Settings → Pano" opens directly on the Pano tab.
enum SettingsTab: String {
    case general
    case backup
    case selfHosted
    case pano
    case observability
    case finder
}

struct SettingsView: View {
    /// Optional pre-selected tab.  `nil` defaults to the General tab.
    /// Provided by callers that want to deep-link into a specific tab
    /// (e.g. the PanoMergeView "Configure in Settings → Pano" action).
    var initialTab: SettingsTab? = nil

    @State private var selectedTab: SettingsTab = .general

    var body: some View {
        TabView(selection: $selectedTab) {
            GeneralSettingsTab()
                .tabItem { Label("General", systemImage: "gear") }
                .tag(SettingsTab.general)
            BackupSettingsView()
                .tabItem { Label("Backup", systemImage: "icloud.and.arrow.up") }
                .tag(SettingsTab.backup)
            SelfHostedSettingsTab()
                .tabItem { Label("Cloud", systemImage: "cloud") }
                .tag(SettingsTab.selfHosted)
            PanoSettingsView()
                .tabItem { Label("Pano", systemImage: "photo.stack") }
                .tag(SettingsTab.pano)
                .accessibilityIdentifier("settings.tab.pano")
            ObservabilitySettingsTab()
                .tabItem { Label("Observability", systemImage: "waveform.path.ecg") }
                .tag(SettingsTab.observability)
            #if os(macOS)
            FileProviderSettingsView()
                .tabItem { Label("Finder", systemImage: "folder") }
                .tag(SettingsTab.finder)
            #elseif os(iOS)
            FileProviderSettingsViewIOS()
                .tabItem { Label("Files", systemImage: "folder") }
                .tag(SettingsTab.finder)
            #endif
        }
        #if os(macOS)
        .frame(width: 540, height: 480)
        #endif
        .onAppear {
            if let tab = initialTab {
                selectedTab = tab
            }
        }
    }
}

private struct GeneralSettingsTab: View {
    @AppStorage(AmazeFlag.defaultsKey) private var useAmaze: Bool = false
    // Control-panel layout variant for the Pro Editor canvas-first shell.
    // Bound to the same @AppStorage key EditorView reads so toggling here
    // flips the editor layout immediately.
    @AppStorage("proControlVariant") private var controlVariant: String = ControlVariant.compact.rawValue

    var body: some View {
        Form {
            LabeledContent("Version") {
                Text(MapleCore.version())
                    .foregroundStyle(.secondary)
            }
            Section("Editor") {
                Picker("Control layout", selection: $controlVariant) {
                    Text("Card").tag(ControlVariant.compact.rawValue)
                    Text("Panel").tag(ControlVariant.panel.rawValue)
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Pro Editor control panel layout")
                .accessibilityIdentifier("general.settings.proControlVariant")
            }
            Section("Experimental") {
                Toggle(isOn: $useAmaze) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("AMaZE demosaic")
                        Text("Higher-quality demosaic on the full-res preview and export; slower.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("general.settings.useAmazeDemosaic")
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
    /// Single sheet entry point. `.fresh` for "Add Server…", `.prefilled(host)`
    /// for a per-server "Sign In" (#1381).
    @State private var sheetTarget: AddCloudSheetTarget?
    /// Per-server signed-in state, derived from Keychain token presence. This
    /// is a separate macOS Settings scene, so it can't observe the app's
    /// AuthSession cache — but a failed refresh clears the tokens, so token
    /// presence is an accurate "signed in?" signal. Refreshed on appear, on
    /// registry changes, and after the sign-in sheet closes.
    @State private var signedIn: [URL: Bool] = [:]

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
                            // Signed out (token cleared by a failed refresh, or
                            // a server signed out) — offer a way back in (#1381).
                            if signedIn[url] == false {
                                Button("Sign In") {
                                    sheetTarget = .prefilled(url.host ?? url.absoluteString)
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                            }
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
                Button("Add Server…") { sheetTarget = .fresh }
                    .keyboardShortcut("n", modifiers: .command)
            }
        }
        .padding(24)
        .task { refreshSignedIn() }
        .onChange(of: registry.servers) { _, _ in refreshSignedIn() }
        .sheet(item: $sheetTarget) { target in
            AddMapleCloudSheet(
                prefilledDomain: target.prefill,
                onDismiss: { sheetTarget = nil },
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
                        sheetTarget = nil
                        refreshSignedIn()
                    }
                }
            )
        }
    }

    /// Re-read Keychain token presence for every registered server.
    private func refreshSignedIn() {
        var map: [URL: Bool] = [:]
        for url in registry.servers {
            // Distinguish "no entry" (definitively signed out → offer Sign In)
            // from a transient Keychain read failure (locked Keychain /
            // errSecInteractionNotAllowed). On a read failure, assume signed in
            // so we don't flash a spurious Sign In button — mirrors the
            // transient-vs-definitive handling in AuthSession.bootstrapAndRestore.
            do {
                map[url] = try TokenStore.load(server: url) != nil
            } catch {
                map[url] = true
            }
        }
        signedIn = map
    }
}
