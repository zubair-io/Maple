// MapleApp.swift — Entry point: SwiftUI App with three-column shell.
//
// Mac/iPad: NavigationSplitView (AppShell).
// iPhone: TabView collapse in AppShell.

import CoreText
import MapleBackup
import MapleCore
import MapleUI
import SwiftUI
import WidgetKit

#if canImport(UIKit)
  import UIKit
#endif

extension Notification.Name {
  /// Posted by the AppShell grant flows the moment the user grants Photos
  /// access in-app, so launch-gated work (the backup boot) can start
  /// without waiting for the next cold start. PhotoKit itself publishes no
  /// authorization-change notification (#2454), so this is the only signal.
  static let maplePhotosAccessGranted = Notification.Name("maplePhotosAccessGranted")
}

@main
struct MapleApp: App {
  /// One `AuthSession` per Self-Hosted server URL. Lazily created by
  /// `session(for:)` and shared across views via `.environment(_:)`.
  /// Plan 2026-04-28-passkey-auth Task B8.
  @State private var sessions: [URL: AuthSession] = [:]
  @Environment(\.scenePhase) private var scenePhase

  init() {
    // Preserve the published early-feature default for Panorama (#3773).
    FeatureFlags.publishResolvedFlags()
    Self.registerBundledFonts()
    Self.installMemoryPressureObserver()
    BGTaskRegistration.register()
    // #1338 — MUST run on the main thread, before any GpuLiveSession
    // actor could read CanvasColorSpace.current: this is the one-time
    // UIScreen/NSScreen probe that seeds the P3-vs-sRGB default for an
    // unset Settings key. See CanvasColorSpace's file banner for why
    // this can't just be resolved lazily on first (possibly background-
    // thread) read.
    CanvasColorSpace.primeMainDisplayCapability()
    // #1740 M2 escape hatch — must run BEFORE the first Auto-Profile fit
    // (cold-open develop), so the Rust FFI's `MAPLE_AUTO1` env read sees
    // whichever of the two toggles (env var already present, or the
    // `-MapleAuto1 1` launch argument) restored the Auto 1.0 fit (Auto
    // 2.0 is the default since the M2 flip). See Auto1Flag's module doc
    // for why `open -n` needs the launch-argument form.
    Auto1Flag.propagateToProcessEnvironmentIfNeeded()
    #if os(macOS)
      AgentBridgeController.shared.syncWithPreference()
    #endif

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
        !fixture.isEmpty
      {
        let root =
          ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE_ROOT"]
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
    // Resolves the server's LAN address (if any) so per-feature clients
    // constructed later can prefer it over `server` — see
    // `LocalNetworkResolver` for why this is a sibling task rather than
    // folded into `bootstrapAndRestore()`.
    Task { await LocalNetworkResolver.shared.resolve(identity: server) }
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
    .commands { CanvasZoomCommands() }
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
        NavigationStack {
          SettingsView(sessionFor: { server in session(for: server) })
        }
      }

      // Per-server administration (#2766). A separate resizable window
      // rather than a Settings tab: the Settings scene is a fixed
      // 840×560 and the Workers table arriving in #2768 is eight columns
      // wide. Keyed by server URL so two servers can be administered
      // side by side.
      WindowGroup(id: "server-admin", for: URL.self) { $server in
        if let server {
          ServerAdminView(server: server, session: session(for: server))
        }
      }
      .defaultSize(width: 900, height: 620)
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
        ObservabilityController.shared.start(
          refreshExecutor: BackgroundExecution()
        )
      }
      .task {
        await Self.startBackupIfAuthorized()
      }
      .onReceive(
        NotificationCenter.default.publisher(
          for: .maplePhotosAccessGranted)
      ) { _ in
        // The user granted Photos access through the in-app flow
        // after a cold start that skipped the backup boot — start
        // it now instead of waiting for the next launch (#2851).
        Task { await Self.startBackupIfAuthorized() }
      }
      .onChange(of: scenePhase) { _, newPhase in
        if newPhase == .background {
          BGTaskRegistration.schedule()
        }
        if newPhase == .active {
          // Deterministic widget refresh: WidgetKit's own
          // schedule is budgeted (and Low Power Mode all but
          // stops it), which strands the widget on its
          // placeholder after a transient fetch failure.
          // Opening the app is the user's natural "make it
          // update" gesture, so honour it. Reload requests are
          // coalesced by the system — this does not burn the
          // widget's own refresh budget.
          WidgetCenter.shared.reloadAllTimelines()
        }
        #if os(iOS)
          if newPhase == .active {
            // Re-foreground: signal every active File Provider
            // domain so the next Files-app refresh sees fresh
            // server state. Best-effort; failures surface in the
            // in-app status banner via the SHARED model instance
            // (`FileProviderSettingsModel.shared`) — a
            // throwaway `FileProviderSettingsModel()` here would
            // set `statusMessage` on an object nobody observes,
            // silently dropping the failure (#2539).
            Task { await FileProviderSettingsModel.shared.refreshAll() }
          }
        #endif
      }
  }

  /// Boot the backup engine + PhotoKit change-observer wiring, but only
  /// when Photos authorization is already in hand. Starting either without
  /// access used to raise the system permission dialog at launch with zero
  /// user interaction — registering a `PHPhotoLibraryChangeObserver` while
  /// `.notDetermined` IS an authorization request (#2454, #2851) — and let
  /// the engine burn retry counts on rehydrated uploads whose assets can't
  /// be fetched. When access is missing, the sidebar's lost-permission
  /// warning is the user-visible signal; granting through the in-app flow
  /// posts `.maplePhotosAccessGranted`, which re-runs this.
  @MainActor
  static func startBackupIfAuthorized() async {
    guard !BackupSettings.isStoppedByUser, let settings = BackupSettings.load(),
      settings.isConfigured,
      URL(string: settings.serverURL) != nil
    else { return }
    // A configured backup could only have been set up with library access
    // in hand — latch that evidence so users whose grant was revoked
    // before PhotosAccessMemory existed still get the sidebar warning.
    PhotosAccessMemory.latchGrantEvidence()
    let status = PhotoKitLibrary.authorizationStatus()
    guard status == .authorized || status == .limited else { return }
    await EngineHost.shared.start(settings: settings)
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

  /// Forward memory-pressure / low-memory signals to every cache that
  /// holds hot in-memory entries, before the OS jettisons us. On macOS,
  /// `DispatchSource.makeMemoryPressureSource` fires at warn/critical; on
  /// iOS, `UIApplication.didReceiveMemoryWarningNotification`.
  ///
  /// Three responses fan out from the same signal (#2037 — broadened from
  /// thumbnails-only, which left the much larger rendered-preview and
  /// per-editor decoded/tile/GPU buffers resident under pressure):
  ///   * `ThumbnailLoader` — the grid's in-memory thumbnail cache (already
  ///     wired; small, already-bounded).
  ///   * `RenderedPreviewCache` — up to 20 full-viewport `CIImage`s; both
  ///     are process-wide singletons this observer can reach directly.
  ///   * `MemoryPressureSignal` — `AppShell.sessions` (the decoded-image
  ///     cache, deep-zoom tiles, and GPU-live session per open editor) is
  ///     plain SwiftUI `@State` with no handle reachable from here, so the
  ///     signal is bumped and `AppShell` observes it (mirrors the
  ///     `DeepLinkRouter` cross-layer idiom — see `MemoryPressureSignal`'s
  ///     header doc) and fans out to every INACTIVE session itself.
  private static func installMemoryPressureObserver() {
    let respond = {
      Task { await ThumbnailLoader.shared.handleMemoryPressure() }
      Task { await RenderedPreviewCache.shared.handleMemoryPressure() }
      Task { @MainActor in MemoryPressureSignal.shared.signalPressure() }
    }
    #if os(macOS)
      let src = DispatchSource.makeMemoryPressureSource(
        eventMask: [.warning, .critical],
        queue: .global(qos: .utility)
      )
      src.setEventHandler(handler: respond)
      src.resume()
      // Keep the source alive for the app lifetime — stash on a throwaway
      // static so ARC doesn't deallocate it.
      _memoryPressureSource = src
    #elseif canImport(UIKit)
      NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification,
        object: nil,
        queue: .main
      ) { _ in respond() }
    #endif
  }
}

#if os(macOS)
  private nonisolated(unsafe) var _memoryPressureSource: DispatchSourceMemoryPressure?
#endif
