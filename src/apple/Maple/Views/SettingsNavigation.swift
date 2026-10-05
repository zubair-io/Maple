// SettingsNavigation.swift — Settings tab destinations and navigation helpers (#4245).

import Foundation

/// Settings tab destinations across macOS and iOS shells.
enum SettingsTab: String, CaseIterable, Identifiable {
  case general
  case backup
  case selfHosted
  case sources
  case pano
  case observability
  case finder
  case mapleUIGallery
  case about

  var id: String { rawValue }
}

/// Helpers for routing and deep-linking into Maple's Settings tabs (#4245).
enum SettingsNavigation {
  /// The UserDefaults key used to persist and deep-link the active settings tab.
  static let tabDefaultsKey = "cm.settings.tab"

  /// Sets the target tab in UserDefaults for cross-window / cross-scene navigation.
  static func setTargetTab(_ tab: SettingsTab, defaults: UserDefaults = .standard) {
    defaults.set(tab.rawValue, forKey: tabDefaultsKey)
  }

  /// Resolves the tab to present, falling back to `.general` if the requested tab is disabled.
  static func resolveInitialTab(requested: SettingsTab?, isPanoEnabled: Bool) -> SettingsTab {
    guard let requested else { return .general }
    if requested == .pano && !isPanoEnabled {
      return .general
    }
    return requested
  }
}
