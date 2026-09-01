// BuildProvenance.swift — git SHA + build date attribution for Settings >
// About (#1804).
//
// Device screenshots were unattributable to a commit — triaging #1780/#1781/
// #1801 repeatedly stalled on "which commit is in this TestFlight build?".
//
// The app target sets `GENERATE_INFOPLIST_FILE = YES`, so there is no
// committed Info.plist to add static keys to, and the values here (a git
// SHA, a build timestamp) are only known at build time anyway — a static
// `INFOPLIST_KEY_*` build setting can't express them. Instead the "Stamp
// build provenance" Run Script build phase (`project.pbxproj`, last phase on
// the "Maple Exposure" target so it runs after Info.plist has already been
// generated and copied into the bundle being signed) shells out to
// `/usr/libexec/PlistBuddy` and writes `MapleBuildGitSHA` / `MapleBuildDate`
// directly into the built Info.plist. Xcode Cloud sets `CI_COMMIT` to the
// commit being built (`ci_scripts/ci_post_clone.sh` runs before this phase,
// same as every other build step); a local build falls back to `git
// rev-parse` against `SRCROOT`. This reads back whatever that phase wrote,
// so it Just Works in Xcode Cloud archives, TestFlight builds, and local
// `xcodebuild`/Xcode runs alike — no code changes needed per-platform.

import Foundation

enum BuildProvenance {
    /// Short (12-char) git commit SHA the running build was compiled from,
    /// or `"unknown"` if the stamping phase didn't run (e.g. a build system
    /// other than Xcode, or `git` unavailable and outside Xcode Cloud).
    static var gitSHA: String {
        stamped(key: "MapleBuildGitSHA")
    }

    /// UTC build timestamp (ISO 8601, e.g. "2026-09-01T21:04:00Z") the
    /// running build was compiled at, or `"unknown"` if unstamped.
    static var buildDate: String {
        stamped(key: "MapleBuildDate")
    }

    /// Single-line summary for the About screen's accessibility value and
    /// any log line that wants both fields together.
    static var summary: String {
        "\(gitSHA) · \(buildDate)"
    }

    private static func stamped(key: String) -> String {
        guard let value = Bundle.main.infoDictionary?[key] as? String, !value.isEmpty else {
            return "unknown"
        }
        return value
    }
}
