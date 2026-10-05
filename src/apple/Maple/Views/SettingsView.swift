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

/// Section groupings for Settings destinations.
enum SettingsSection: String, CaseIterable, Identifiable {
  case general = "General"
  case observability = "Observability"
  case files = "Files"
  case app = "App"

  var id: String { rawValue }
}

/// Destination identifiers shared by Settings across all Apple platforms.
enum SettingsTab: String, CaseIterable, Identifiable {
  case general
  case backup
  case selfHosted
  case pano
  case observability
  case sources
  case finder
  case about
  case mapleUIGallery

  var id: String { rawValue }

  var section: SettingsSection {
    switch self {
    case .general, .backup, .selfHosted, .pano:
      return .general
    case .observability:
      return .observability
    case .sources, .finder:
      return .files
    case .about, .mapleUIGallery:
      return .app
    }
  }

  var icon: String {
    switch self {
    case .general: return "gear"
    case .backup: return "icloud.and.arrow.up"
    case .selfHosted: return "cloud"
    case .pano: return "photo.stack"
    case .observability: return "waveform.path.ecg"
    case .sources: return "externaldrive"
    case .finder: return "folder"
    case .about: return "info.circle"
    case .mapleUIGallery: return "square.grid.2x2"
    }
  }

  var label: String {
    switch self {
    case .general: return "General"
    case .backup: return "Backup"
    case .selfHosted: return "Cloud"
    case .pano: return "Pano"
    case .observability: return "Observability"
    case .sources: return "Sources"
    case .finder:
      #if os(macOS)
        return "Finder"
      #else
        return "Files"
      #endif
    case .about: return "About"
    case .mapleUIGallery: return "Maple UI Gallery"
    }
  }

  var accessibilityIdentifier: String? {
    switch self {
    case .sources: return "settings.tab.sources"
    case .pano: return "settings.tab.pano"
    case .about: return "settings.tab.about"
    default: return nil
    }
  }

  var isVisible: Bool {
    switch self {
    case .pano:
      return FeatureFlags.isPanoramaEnabled
    default:
      return true
    }
  }
}

struct SettingsView: View {
  /// Optional pre-selected tab. With `nil`, macOS retains the last selection
  /// in its Settings window; iOS starts on General.
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
    @State private var localSelectedTab: SettingsTab = .general
  #endif

  @State private var pushedTab: SettingsTab?
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  private var selectedTab: SettingsTab {
    get {
      #if os(macOS)
        let tab = navigation.selectedTab
        return (tab == .pano && !FeatureFlags.isPanoramaEnabled) ? .general : tab
      #else
        let tab = localSelectedTab
        return (tab == .pano && !FeatureFlags.isPanoramaEnabled) ? .general : tab
      #endif
    }
    nonmutating set {
      #if os(macOS)
        navigation.selectedTab = newValue
      #else
        localSelectedTab = newValue
      #endif
    }
  }

  var body: some View {
    GeometryReader { geo in
      let isNarrow = horizontalSizeClass == .compact || geo.size.width < 640
      Group {
        if isNarrow {
          narrowView
        } else {
          wideView
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        let effectiveTab = (tab == .pano && !FeatureFlags.isPanoramaEnabled) ? .general : tab
        selectedTab = effectiveTab
        pushedTab = effectiveTab
      }
    }
  }

  private var narrowView: some View {
    List {
      ForEach(SettingsSection.allCases) { section in
        let tabs = visibleTabs(in: section)
        if !tabs.isEmpty {
          Section(section.rawValue) {
            ForEach(tabs) { tab in
              row(for: tab, isNarrow: true)
            }
          }
        }
      }
    }
    #if os(iOS)
      .listStyle(.insetGrouped)
    #else
      .listStyle(.sidebar)
    #endif
    .mapleSettingsBackground()
    .navigationTitle("Settings")
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .navigationDestination(item: $pushedTab) { tab in
      paneView(for: tab)
        .navigationTitle(tab.label)
        #if os(iOS)
          .navigationBarTitleDisplayMode(.inline)
        #endif
    }
  }

  private var wideView: some View {
    HStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
          ForEach(SettingsSection.allCases) { section in
            let tabs = visibleTabs(in: section)
            if !tabs.isEmpty {
              VStack(alignment: .leading, spacing: 2) {
                Text(section.rawValue.uppercased())
                  .font(.system(size: 11, weight: .semibold))
                  .foregroundStyle(MuiTokens.textMuted)
                  .padding(.horizontal, MuiTokens.spacingMd)
                  .padding(.top, MuiTokens.spacingSm)
                  .padding(.bottom, 2)
                ForEach(tabs) { tab in
                  row(for: tab, isNarrow: false)
                }
              }
            }
          }
        }
        .padding(.vertical, MuiTokens.spacingSm)
      }
      .frame(width: 220)
      .background(MuiTokens.surface)

      Rectangle()
        .fill(MuiTokens.border)
        .frame(width: 1)

      paneView(for: selectedTab)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MuiTokens.bg)
    }
    .navigationTitle("Settings")
  }

  private func visibleTabs(in section: SettingsSection) -> [SettingsTab] {
    SettingsTab.allCases.filter { $0.section == section && $0.isVisible }
  }

  @ViewBuilder
  private func row(for tab: SettingsTab, isNarrow: Bool) -> some View {
    let row = MuiListRow(
      icon: tab.icon,
      label: tab.label,
      active: isNarrow ? false : selectedTab == tab,
      pressed: {
        if isNarrow {
          pushedTab = tab
        } else {
          selectedTab = tab
          #if os(macOS)
            SettingsNavigation.shared.selectedTab = tab
          #endif
        }
      },
      trailing: {
        if isNarrow {
          MuiIcon(name: "chevron_right", size: .sm, color: MuiTokens.textMuted)
        }
      }
    )
    if let id = tab.accessibilityIdentifier {
      row.accessibilityIdentifier(id)
    } else {
      row
    }
  }

  @ViewBuilder
  private func paneView(for tab: SettingsTab) -> some View {
    switch tab {
    case .general:
      GeneralSettingsTab()
    case .backup:
      BackupSettingsView()
    case .selfHosted:
      SelfHostedSettingsTab(sessionFor: sessionFor)
    case .pano:
      if FeatureFlags.isPanoramaEnabled {
        PanoSettingsView()
      } else {
        GeneralSettingsTab()
      }
    case .observability:
      ObservabilitySettingsTab()
    case .sources:
      LibrarySourcesSettingsView()
    case .finder:
      #if os(macOS)
        FileProviderSettingsView()
      #elseif os(iOS)
        FileProviderSettingsViewIOS()
      #endif
    case .about:
      AboutView()
    case .mapleUIGallery:
      MapleUIGalleryView()
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
