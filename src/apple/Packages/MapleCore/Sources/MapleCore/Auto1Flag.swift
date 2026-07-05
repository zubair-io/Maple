// Auto1Flag.swift — dev-only escape hatch restoring the Auto 1.0 free-LUT
// Auto Profile fit (epic #1740, milestone M2). Since the M2 flip, Auto 2.0's
// structured fit is the DEFAULT; this flag inverts the M1 dev A/B's
// `MAPLE_AUTO2` plumbing to bring Auto 1.0 back for comparison. NOT a
// product setting — see the module doc below for why this is intentionally
// an env var / launch-argument toggle instead of a DB-backed settings-page
// control.
//
// The actual swap lives entirely in `raw-core`
// (`view::auto_profile::apply_pipeline::auto1_enabled_by_env`, read via
// `std::env::var_os("MAPLE_AUTO1")` at Auto-Profile-fit time) — the Rust FFI
// calls run in THIS process, so once `MAPLE_AUTO1` is set in the process
// environment (by any means), every `maple_compute_auto_profile_lut` /
// `maple_gpu_fit_auto_profile` call picks it up with no parameter threading
// needed on the Swift side.
//
// The only Swift-side job is making sure `MAPLE_AUTO1` actually LANDS in the
// process environment, because the two ways an engineer would plausibly
// launch this dev build behave differently:
//   * `MAPLE_AUTO1=1 /path/to/Maple.app/Contents/MacOS/Maple` (direct binary
//     launch) — the env var is already in the process environment; nothing
//     to do.
//   * `MAPLE_AUTO1=1 open -n /path/to/Maple.app` — verified on macOS 26:
//     `open` does NOT propagate the invoking shell's environment to the
//     launched app (LaunchServices starts the app via a fresh launchd-style
//     environment, not a fork of the `open` process). This is the practical
//     way most engineers will launch a built .app for a quick A/B look, so it
//     is the case this flag exists to support: read the `-MapleAuto1 1`
//     launch ARGUMENT instead (NSUserDefaults' "argument domain" — Apple's
//     mechanism for launch-time overrides — populates `UserDefaults.standard`
//     from `-KeyName value` pairs automatically, no parsing needed), then
//     `setenv` the Rust-visible var from it at startup.
import Foundation

/// Dev-only escape hatch restoring the Auto 1.0 Auto Profile fit after the
/// #1740 M2 flip made Auto 2.0 the default. `isEnabled` is `false` by
/// default (Auto 2.0 ships). THIS IS TEMPORARY — it exists so the TestFlight
/// evaluation window can A/B against the previous fit; the epic's close-out
/// removes this file and the `MAPLE_AUTO1` env var entirely once the flip is
/// confirmed. Not wired to any Settings page: it swaps an internal fit
/// algorithm for developer comparison, not a behavior an end user chooses,
/// so it does not belong in the DB-backed settings system the repo otherwise
/// requires for product toggles.
public enum Auto1Flag {
    /// UserDefaults key populated by the `-MapleAuto1 1` launch argument (NOT
    /// a Settings-UI-backed key — there is no `@AppStorage` toggle for this).
    public static let launchArgumentKey = "MapleAuto1"

    /// Whether the Auto 1.0 fit is restored for this process.
    ///
    /// Resolution order (highest priority first):
    ///   1. `MAPLE_AUTO1` already in the process environment (e.g. a direct
    ///      binary launch: `MAPLE_AUTO1=1 /path/to/Maple.app/Contents/MacOS/Maple`).
    ///   2. The `-MapleAuto1 1` launch argument (e.g.
    ///      `open -n /path/to/Maple.app --args -MapleAuto1 1`) — `open` does
    ///      NOT propagate env vars, so this is the practical toggle for an
    ///      `open`-launched build.
    public static var isEnabled: Bool {
        if let env = ProcessInfo.processInfo.environment["MAPLE_AUTO1"] {
            return env != "0" && !env.isEmpty
        }
        return UserDefaults.standard.bool(forKey: launchArgumentKey)
    }

    /// Call once at app startup (before any Auto-Profile fit runs). If the
    /// launch-argument form of the toggle is present, mirrors it into the
    /// process environment via `setenv` so the Rust FFI's own
    /// `std::env::var_os("MAPLE_AUTO1")` read (in
    /// `raw_core::view::auto_profile::apply_pipeline::auto1_enabled_by_env`)
    /// sees it — the FFI has no parameter for this; it is an env-only dev
    /// knob by design (see this file's module doc). A no-op if `MAPLE_AUTO1`
    /// is already set (a direct binary launch already has it) or the
    /// launch argument wasn't passed.
    public static func propagateToProcessEnvironmentIfNeeded() {
        guard ProcessInfo.processInfo.environment["MAPLE_AUTO1"] == nil else { return }
        guard UserDefaults.standard.bool(forKey: launchArgumentKey) else { return }
        setenv("MAPLE_AUTO1", "1", 1)
    }
}
