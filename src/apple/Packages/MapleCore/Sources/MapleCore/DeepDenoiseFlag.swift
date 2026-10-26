// DeepDenoiseFlag.swift — the patent-review gate on deep denoise (#5381,
// #5213 decision 9).
//
// The BM3D patent review has not cleared, so the Deep denoise control must
// not be reachable in a shipping build. A Release build compiles the gate to
// a constant `false`, so no setting, default or launch argument can open it;
// a Debug build reads the internal toggle on Settings → General (Rendering).
// The #3773 `FeatureFlags` gate is gone (#4567), so the build configuration
// is the line between shipping and internal builds.
//
// The gate hides the control only. A sidecar that already carries
// `papp:DeepDenoise` still renders exactly as it did.

import Foundation

public enum DeepDenoiseFlag {
  /// UserDefaults key behind the Debug-only Settings toggle.
  public static let defaultsKey = "enableDeepDenoise"

  /// Whether the Deep denoise control is shown. Re-read on every call.
  public static var isEnabled: Bool {
    #if DEBUG
      UserDefaults.standard.bool(forKey: defaultsKey)
    #else
      false
    #endif
  }
}
