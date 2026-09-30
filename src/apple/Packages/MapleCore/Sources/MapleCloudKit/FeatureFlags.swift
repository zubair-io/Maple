// FeatureFlags.swift — Panorama stitching rollout gate (#3773).
//
// Cloud features are available in every build (#3893). The remaining
// Panorama gate defaults off in App Store/TestFlight releases and on in
// Debug or early releases. Existing Panorama and early-feature overrides
// retain their precedence: environment, launch argument/UserDefaults,
// stamped Info.plist, published App Group value, prerelease version, Debug.

import Foundation

public enum FeatureFlags {
  // MARK: - Configuration Keys

  /// Plist / UserDefaults keys.
  public static let earlyFeaturesKey = "MapleEarlyFeatures"
  public static let panoFeaturesKey = "MapleEnablePano"

  /// App Group key the app publishes its resolved master toggle under, so
  /// consumers that never see the app's stamped Info.plist or launch
  /// arguments can resolve the same early-feature default.
  public static let publishedEarlyFeaturesKey = "MapleEarlyFeaturesPublished"

  /// Environment variable names.
  public static let earlyFeaturesEnvVar = "MAPLE_EARLY_FEATURES"
  public static let panoEnvVar = "MAPLE_ENABLE_PANO"

  // MARK: - Public Feature Gates

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

  /// Master toggle for early access Panorama stitching.
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

    // 4. The app's published resolution (extensions follow the app)
    let shared = sharedDefaults()
    if shared.object(forKey: publishedEarlyFeaturesKey) != nil {
      return shared.bool(forKey: publishedEarlyFeaturesKey)
    }

    // 5. Version string inspection (e.g. "0.0.8-test.1", "1.0.0-alpha")
    if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
      isPrereleaseVersion(version)
    {
      return true
    }

    // 6. Default: enabled in Debug, disabled in Release
    #if DEBUG
      return true
    #else
      return false
    #endif
  }

  // MARK: - App Group publication

  /// Called once at app launch. Writes the app's resolved master toggle to the
  /// App Group, preserving the early-feature default used by Panorama.
  public static func publishResolvedFlags() {
    sharedDefaults().set(areEarlyFeaturesEnabled, forKey: publishedEarlyFeaturesKey)
  }

  /// The App Group suite every Maple target joins; `.standard` when the suite
  /// cannot be created (unit tests without a host app).
  static func sharedDefaults() -> UserDefaults {
    UserDefaults(suiteName: CloudServerRegistry.appGroupID) ?? .standard
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
