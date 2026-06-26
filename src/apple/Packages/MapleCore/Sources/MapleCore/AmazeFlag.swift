// AmazeFlag.swift — runtime gate for the AMaZE demosaic on the refine /
// export path (ticket #940).
//
// AMaZE is a higher-quality but slower Bayer demosaic algorithm. It is
// compiled in unconditionally but is OFF by default — the production default
// is `.full` (bilinear), which is what shipped before #940.
//
// Two ways to enable:
//   1. User toggle in Settings → General → "AMaZE demosaic (experimental)"
//      — persisted to UserDefaults key `useAmazeDemosaic`.
//   2. Launch environment `MAPLE_AMAZE=1` — opt-in for tests / CI; also
//      acts as an always-on override (takes precedence over UserDefaults).
//      Passing `MAPLE_AMAZE=0` explicitly forces it off even if the
//      UserDefaults toggle is on.
//
// Render paths that honour this flag:
//   • Refine pass   — `RenderActor+DecodedCache` full-res `sharedDecode`
//   • Export path   — `RenderActor.renderForExport`
// The fast / preview path is always `.preview` (half-res bilinear) —
// unaffected by this flag.

import Foundation

/// Runtime gate for the AMaZE demosaic on the refine / export path.
/// `isEnabled` is `false` by default; flip via UserDefaults or `MAPLE_AMAZE`.
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
    ///   3. Default: `false` (bilinear / `.full`).
    public static var isEnabled: Bool {
        let env = ProcessInfo.processInfo.environment["MAPLE_AMAZE"]
        if env == "1" { return true }
        if env == "0" { return false }
        return UserDefaults.standard.bool(forKey: defaultsKey)
    }
}
