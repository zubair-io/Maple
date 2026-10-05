import MapleCore
import MapleUI
import Observation
import SwiftUI

#if os(macOS)
  /// Shared by the Settings scene and entry points that request a specific
  /// pane before opening it (currently panorama provisioning).
  @MainActor
  @Observable
  final class SettingsNavigation {
    static let shared = SettingsNavigation()
    var selectedTab: SettingsTab = .general
  }
#endif

/// Tab identifiers shared by Settings and its panorama setup entry point.
enum SettingsTab: String {
  case general
  case backup
  case selfHosted
  case sources
  case pano
  case observability
  case finder
  case mapleUIGallery
  case about
}

struct SettingsView: View {
  /// Optional pre-selected tab. With `nil`, macOS retains the last selection
  /// in its Settings window; iOS starts a new sheet on General.
  /// Provided by callers that want to deep-link into a specific tab
  /// (e.g. the PanoMergeView "Configure in Settings → Pano" action).
  var initialTab: SettingsTab? = nil

  /// Resolves the shared per-server `AuthSession` for the Cloud tab's
  /// ServerAdmin entry point (#2766). Defaults to the preview/test
  /// fallback, which is NOT cached across calls — production callers
  /// pass `MapleApp.session(for:)`.
  var sessionFor: @MainActor (URL) -> AuthSession = AppShell.defaultSessionResolver

  #if os(macOS)
    @Bindable private var navigation = SettingsNavigation.shared
  #else
    @State private var selectedTab: SettingsTab = .general
  #endif

  private var tabSelection: Binding<SettingsTab> {
    #if os(macOS)
      $navigation.selectedTab
    #else
      $selectedTab
    #endif
  }

  var body: some View {
    TabView(selection: tabSelection) {
      GeneralSettingsTab()
        .tabItem { Label("General", systemImage: "gear") }
        .tag(SettingsTab.general)
      BackupSettingsView()
        .tabItem { Label("Backup", systemImage: "icloud.and.arrow.up") }
        .tag(SettingsTab.backup)
      SelfHostedSettingsTab(sessionFor: sessionFor)
        .tabItem { Label("Cloud", systemImage: "cloud") }
        .tag(SettingsTab.selfHosted)
      // #2925: the sidebar hides source sections with nothing
      // connected, which takes their "+" buttons with them. This tab
      // is where sources are registered and removed instead.
      LibrarySourcesSettingsView()
        .tabItem { Label("Sources", systemImage: "externaldrive") }
        .tag(SettingsTab.sources)
        .accessibilityIdentifier("settings.tab.sources")
      if FeatureFlags.isPanoramaEnabled {
        PanoSettingsView()
          .tabItem { Label("Pano", systemImage: "photo.stack") }
          .tag(SettingsTab.pano)
          .accessibilityIdentifier("settings.tab.pano")
      }
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
      // Maple UI design-system Apple phase — dev-facing catalog of
      // shipped tokens/atoms, not a user-facing settings surface, but
      // hung off Settings since that's the app's one place every
      // build already has a navigable modal/tab shell to reuse.
      NavigationStack {
        MapleUIGalleryView()
      }
      .tabItem { Label("Maple UI", systemImage: "square.grid.2x2") }
      .tag(SettingsTab.mapleUIGallery)
      // #1804: build provenance (git SHA + build date) attributable
      // at a glance, same content as the phone settings' About row.
      AboutView()
        .tabItem { Label("About", systemImage: "info.circle") }
        .tag(SettingsTab.about)
        .accessibilityIdentifier("settings.tab.about")
    }
    #if os(macOS)
      .frame(width: 840, height: 560)
      // Settings is a separate scene and does not inherit AppShell's
      // appearance. Its dark Maple row surfaces need matching system text
      // and window chrome even when macOS itself uses Light appearance.
      .preferredColorScheme(.dark)
    #endif
    .onAppear {
      if let tab = initialTab {
        let panoDisabled = tab == .pano && !FeatureFlags.isPanoramaEnabled
        if panoDisabled {
          tabSelection.wrappedValue = .general
        } else {
          tabSelection.wrappedValue = tab
        }
      }
    }
  }
}

struct GeneralSettingsTab: View {
  // Default mirrors `AmazeFlag.isEnabled` (ON since #940) so the toggle
  // reads correctly before the key is ever written.
  @AppStorage(AmazeFlag.defaultsKey) private var useAmaze: Bool = true
  // Canvas colorspace (#1338) — default mirrors `CanvasColorSpace.current`
  // (P3 if the display reports the gamut, sRGB otherwise) so the picker
  // reads correctly before the key is ever written, same pattern as
  // `useAmaze` above.
  @AppStorage(CanvasColorSpace.defaultsKey) private var canvasColorSpace = CanvasColorSpace.current
    .rawValue

  var body: some View {
    Form {
      Section("Rendering") {
        Toggle(isOn: $useAmaze) {
          VStack(alignment: .leading, spacing: 2) {
            Text("AMaZE demosaic")
            Text(
              "Highest-quality demosaic on the full-res preview and export. Turn off to fall back to bilinear."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("general.settings.useAmazeDemosaic")
        VStack(alignment: .leading, spacing: 6) {
          // Sanitizing binding (Copilot review on #3192): the raw
          // Int in @AppStorage could in principle hold a value
          // outside {0, 1} (corrupted defaults, a future enum case
          // later removed) that matches neither .tag() below and
          // would render the segmented control with nothing
          // selected. The getter falls back to `.current`'s raw
          // value in that case — NOT a hardcoded sRGB (jules review:
          // a hardcoded sRGB fallback here would show "sRGB"
          // selected while the canvas itself, reading the same
          // out-of-range stored value through `CanvasColorSpace
          // .current`, actually falls back to the display-
          // capability default and could be rendering P3) — so the
          // picker always mirrors what's actually on screen. The
          // setter writes straight through since a Picker only
          // ever sets one of the two valid tags.
          Picker(
            "Editor canvas colorspace",
            selection: Binding(
              get: {
                CanvasColorSpace(rawValue: canvasColorSpace)?.rawValue
                  ?? CanvasColorSpace.current.rawValue
              },
              set: { canvasColorSpace = $0 }
            )
          ) {
            Text("Display P3").tag(CanvasColorSpace.displayP3.rawValue)
            Text("sRGB").tag(CanvasColorSpace.srgb.rawValue)
          }
          .pickerStyle(.segmented)
          Text(
            "Display P3 uses the panel's full gamut on a P3-capable display. Takes effect on the next render — no restart needed."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("general.settings.canvasColorSpace")
      }
      .listRowBackground(MapleTokens.surface)
      #if os(macOS)
        AgentBridgeSettingsSection()
      #endif
    }
    .formStyle(.grouped)
    .mapleSettingsBackground()
    #if os(macOS)
      .padding(24)
    #endif
  }
}
