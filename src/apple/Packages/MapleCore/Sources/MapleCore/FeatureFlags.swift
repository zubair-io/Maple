// FeatureFlags.swift — Feature flag gates for Maple Cloud and Panorama stitching.
//
// App Store preparation:
// Features that depend on the Maple Cloud backend (e.g. Map view, Cloud server
// browsing/sources, PhotoKit backup, Files integration, Cloud search) and
// Panorama stitching are hidden by default in release builds (App Store & TestFlight).
//
// CI/CD early test releases (e.g. version tags containing `-test`, `-alpha`, `-beta`,
// or builds stamped with `MapleEarlyFeatures = true`) have these features enabled.
//
// Precedence hierarchy for each flag:
//   1. Environment variable (`MAPLE_ENABLE_CLOUD`, `MAPLE_ENABLE_PANO`, `MAPLE_EARLY_FEATURES`)
//   2. Launch argument / UserDefaults (`-MapleEnableCloud`, `-MapleEnablePano`, `-MapleEarlyFeatures`)
//   3. Stamped Info.plist key (`MapleEnableCloud`, `MapleEnablePano`, `MapleEarlyFeatures`)
//   4. Version tag analysis (`CFBundleShortVersionString` carrying a prerelease suffix e.g. `-test.1`)
//   5. `#if DEBUG` default (true in debug, false in release)

import Foundation

public enum FeatureFlags {
  // MARK: - Configuration Keys

  /// Plist / UserDefaults keys.
  public static let earlyFeaturesKey = "MapleEarlyFeatures"
  public static let cloudFeaturesKey = "MapleEnableCloud"
  public static let panoFeaturesKey = "MapleEnablePano"

  /// Environment variable names.
  public static let earlyFeaturesEnvVar = "MAPLE_EARLY_FEATURES"
  public static let cloudEnvVar = "MAPLE_ENABLE_CLOUD"
  public static let panoEnvVar = "MAPLE_ENABLE_PANO"

  // MARK: - Public Feature Gates

  /// Whether Maple Cloud features (Map view, Cloud server sources, Backup, Files integration, Cloud search) are enabled.
  public static var isMapleCloudEnabled: Bool {
    if let env = ProcessInfo.processInfo.environment[cloudEnvVar] {
      if env == "1" { return true }
      if env == "0" { return false }
    }
    if UserDefaults.standard.object(forKey: cloudFeaturesKey) != nil {
      return UserDefaults.standard.bool(forKey: cloudFeaturesKey)
    }
    if let stamped = Bundle.main.infoDictionary?[cloudFeaturesKey] as? Bool {
      return stamped
    }
    return areEarlyFeaturesEnabled
  }

  /// Whether Panorama stitching is enabled.
  public static var isPanoramaEnabled: Bool {
    if let env = ProcessInfo.processInfo.environment[panoEnvVar] {
      if env == "1" { return true }
      if env == "0" { return false }
    }
    if UserDefaults.standard.object(forKey: panoFeaturesKey) != nil {
      return UserDefaults.standard.bool(forKey: panoFeaturesKey)
    }
    if let stamped = Bundle.main.infoDictionary?[panoFeaturesKey] as? Bool {
      return stamped
    }
    return areEarlyFeaturesEnabled
  }

  /// Master toggle for early access features (both Cloud and Panorama).
  public static var areEarlyFeaturesEnabled: Bool {
    // 1. Process environment (explicit override)
    if let env = ProcessInfo.processInfo.environment[earlyFeaturesEnvVar] {
      if env == "1" { return true }
      if env == "0" { return false }
    }

    // 2. Launch argument / UserDefaults
    if UserDefaults.standard.object(forKey: earlyFeaturesKey) != nil {
      return UserDefaults.standard.bool(forKey: earlyFeaturesKey)
    }

    // 3. Stamped Info.plist key
    if let stamped = Bundle.main.infoDictionary?[earlyFeaturesKey] as? Bool {
      return stamped
    }

    // 4. Version string inspection (e.g. "0.0.8-test.1", "1.0.0-alpha")
    if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
      isPrereleaseVersion(version)
    {
      return true
    }

    // 5. Default: enabled in Debug, disabled in Release
    #if DEBUG
      return true
    #else
      return false
    #endif
  }

  // MARK: - Helpers

  /// Checks if a semver string contains a prerelease identifier like `-test.1`, `-alpha`, `-beta`, `-rc`, or `-dev`.
  /// App Store and TestFlight versions strictly require numeric `X.Y.Z` without hyphens or prerelease suffixes.
  public static func isPrereleaseVersion(_ version: String) -> Bool {
    guard let dashIndex = version.firstIndex(of: "-") else { return false }
    let suffix = String(version[dashIndex...]).lowercased()
    let prereleasePatterns = ["-test", "-alpha", "-beta", "-rc", "-dev"]
    return prereleasePatterns.contains { suffix.hasPrefix($0) }
  }
}
