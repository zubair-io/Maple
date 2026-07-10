// AmazeFlag.swift — runtime kill switch for the AMaZE demosaic on the
// refine / export path (ticket #940).
//
// AMaZE is the highest-quality Bayer demosaic and — since the tiled,
// parallel kernel landed (#1887) — costs the same as bilinear at image
// open. It is therefore ON by default (#940). The flag survives as a kill
// switch, mirroring the `MAPLE_GPU_LIVE` pattern:
//
//   1. Settings → General → "AMaZE demosaic" toggle — persisted to
//      UserDefaults key `useAmazeDemosaic`; flip OFF to fall back to
//      bilinear `.full`.
//   2. Launch environment `MAPLE_AMAZE` — "0" forces off, "1" forces on;
//      takes precedence over UserDefaults (tests / CI / triage).
//
// Render paths that honour this flag:
//   • Refine pass   — `RenderActor+DecodedCache` full-res `sharedDecode`
//   • Export path   — `RenderActor.renderForExport`
// The fast / preview path is always `.preview` (half-res) — unaffected.

import Foundation

/// Runtime kill switch for the AMaZE demosaic on the refine / export path.
/// `isEnabled` is `true` by default (#940); flip via UserDefaults or
/// `MAPLE_AMAZE=0`.
public enum AmazeFlag {
    /// UserDefaults key backing the user-facing Settings toggle.
    public static let defaultsKey = "useAmazeDemosaic"

    /// Whether AMaZE demosaic is active for this render. Re-evaluated on
    /// each call so flipping the Settings toggle takes effect on the NEXT
    /// refine without an app restart.
    ///
    /// Resolution order (highest priority first):
    ///   1. `MAPLE_AMAZE` env var — "1" forces on, "0" forces off.
    ///   2. UserDefaults `useAmazeDemosaic` — the user-facing toggle.
    ///   3. Default: `true` (AMaZE on; #940).
    public static var isEnabled: Bool {
        let env = ProcessInfo.processInfo.environment["MAPLE_AMAZE"]
        if env == "1" { return true }
        if env == "0" { return false }
        guard UserDefaults.standard.object(forKey: defaultsKey) != nil else { return true }
        return UserDefaults.standard.bool(forKey: defaultsKey)
    }
}
