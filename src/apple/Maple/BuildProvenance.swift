// #4183: Xcode orders the provenance stamp after Info.plist generation and before signing.
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
