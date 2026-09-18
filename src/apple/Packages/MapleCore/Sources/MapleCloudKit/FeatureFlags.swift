// FeatureFlags.swift — Feature flag gates for Maple Cloud and Panorama stitching.
//
// App Store preparation (#3773):
// Features that depend on the Maple Cloud backend (Map view, Cloud server
// browsing/sources, PhotoKit backup, Files/Finder integration, Cloud search,
// the Generated Search widget) and Panorama stitching are hidden by default
// in release builds (App Store & TestFlight).
//
// Scope: the gate closes every entry point, not only the chrome. Settings
// tabs, sidebar rows and toolbar buttons are hidden, and the non-UI routes
// into the same features — cold-start source restore, `autoPickInitialSource`,
// `maple://source/{id}` deep links, the widget's search deep link, the
// widget timeline itself — all consult the same flag, so a disabled feature
// is unreachable rather than merely undiscoverable.
//
// CI/CD early test releases (version tags carrying a prerelease suffix such
// as `v0.0.8-test.1`, or builds stamped with `MapleEarlyFeatures = true`)
// have these features enabled.
//
// This lives in MapleCloudKit rather than MapleCore so the widget extension
// (which links MapleCloudKit only — it must not pull in RawPipeline) reads
// the same gate as the app. MapleCore re-exports MapleCloudKit, so app code
// that imports MapleCore sees `FeatureFlags` unchanged.
//
// Precedence hierarchy for each flag:
//   1. Environment variable (`MAPLE_ENABLE_CLOUD`, `MAPLE_ENABLE_PANO`, `MAPLE_EARLY_FEATURES`)
//   2. Launch argument / UserDefaults (`-MapleEnableCloud`, `-MapleEnablePano`, `-MapleEarlyFeatures`)
//   3. Stamped Info.plist key (`MapleEnableCloud`, `MapleEnablePano`, `MapleEarlyFeatures`)
//   4. The value the app last published to the App Group (`publishResolvedFlags()`) —
//      how an extension whose own Info.plist is never stamped follows the app
//   5. Version tag analysis (`CFBundleShortVersionString` carrying a prerelease suffix e.g. `-test.1`)
//   6. `#if DEBUG` default (true in debug, false in release)

import Foundation

public enum FeatureFlags {
  // MARK: - Configuration Keys

  /// Plist / UserDefaults keys.
  public static let earlyFeaturesKey = "MapleEarlyFeatures"
  public static let cloudFeaturesKey = "MapleEnableCloud"
  public static let panoFeaturesKey = "MapleEnablePano"

  /// App Group key the app publishes its resolved master toggle under, so
  /// extensions (widget) that never see the app's stamped Info.plist or
  /// launch arguments still agree with it.
  public static let publishedEarlyFeaturesKey = "MapleEarlyFeaturesPublished"

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
  /// App Group so the widget extension — whose own Info.plist the build's
  /// stamping phase never touches and which cannot see the app's launch
  /// arguments — resolves the same answer on its next timeline refresh.
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
