// DeepDenoiseFlag.swift — the patent-review gate on deep denoise (#5381,
// #5213 decision 9).
//
// The BM3D patent review has not cleared, so the Deep denoise control is not
// exposed in shipping builds: the flag defaults OFF everywhere. It follows
// the per-feature runtime-flag pattern (`AmazeFlag`, `GpuLiveFlag`) that
// replaced the #3773 `FeatureFlags` gate when #4567 retired it:
//
//   1. Launch environment `MAPLE_DEEP_DENOISE` — "1" forces on, "0" off;
//      takes precedence (tests, CI, internal triage).
//   2. UserDefaults key `enableDeepDenoise` — an internal opt-in only; no
//      Settings toggle exposes it.
//   3. Default: OFF.
//
// The gate hides the control only. A sidecar that already carries
// `papp:DeepDenoise` still renders exactly as it did, on the CPU decode or
// the GPU capture refine.

import Foundation

public enum DeepDenoiseFlag {
  public static let defaultsKey = "enableDeepDenoise"

  /// Whether the Deep denoise control is shown. Re-read on every call.
  public static var isEnabled: Bool {
    switch ProcessInfo.processInfo.environment["MAPLE_DEEP_DENOISE"] {
    case "1": return true
    case "0": return false
    default: return UserDefaults.standard.bool(forKey: defaultsKey)
    }
  }
}
