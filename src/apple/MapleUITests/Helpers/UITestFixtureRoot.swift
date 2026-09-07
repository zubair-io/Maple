// UITestFixtureRoot.swift — where the UITest runner looks for the gitignored
// RAW fixtures, and what a missing fixture means (#2366).
//
// Two sources, in order:
//   1. `MAPLE_UITEST_FIXTURE_ROOT` in the RUNNER's environment. The scheme
//      forwards it as `TEST_RUNNER_MAPLE_UITEST_FIXTURE_ROOT` (Xcode strips
//      the prefix; a plain `NAME=value` xcodebuild argument is a build
//      setting and never arrives — CLAUDE.md § "#2366"). On the iOS
//      Simulator the scheme's `$(PROJECT_DIR)` is left UNEXPANDED in the
//      xctestrun, so a value still carrying `$(` is treated as unset.
//   2. The repo checkout this bundle was compiled from, via `#filePath` —
//      the compiler bakes this file's absolute source path into the test
//      binary, and the simulator runs on the same Mac that built it. This
//      is what makes the iOS gates (`PhoneExportUITests`,
//      `IpadPresentSeamUITests`) execute under plain `xcodebuild test`.
//
// Verdict rule (the decision #2366 left open): a fixture missing at the
// repo default skip-passes, the convention for absent gitignored RAWs
// (`test_color_pipeline.sh`, CI clones without `test-fixtures/raws/`). A
// fixture missing at a root the operator named EXPLICITLY — an env value
// that resolves somewhere other than the repo default — is misconfiguration
// and fails loudly. The scheme's own value resolves to the repo default, so
// a plain scheme run keeps the skip.

import Foundation
import XCTest

enum UITestFixtureRoot {
  static let environmentKey = "MAPLE_UITEST_FIXTURE_ROOT"

  struct Resolution: Equatable {
    /// Absolute path of the directory fixtures are resolved against.
    let path: String
    /// `true` when the operator named a root other than the repo default.
    let isExplicit: Bool
  }

  enum MissingVerdict: Equatable {
    case skip(String)
    case fail(String)
  }

  /// `<repo>/test-fixtures/raws`, derived from this file's compile-time
  /// location: Helpers/ → MapleUITests/ → apple/ → src/ → repo root.
  static func repoDefault(sourceFilePath: String = #filePath) -> String {
    URL(fileURLWithPath: sourceFilePath)
      .deletingLastPathComponent()  // Helpers/
      .deletingLastPathComponent()  // MapleUITests/
      .deletingLastPathComponent()  // apple/
      .deletingLastPathComponent()  // src/
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("test-fixtures/raws")
      .standardizedFileURL.path
  }

  /// Pure: pick the root from `environment`, falling back to `repoDefault`.
  static func resolve(environment: [String: String], repoDefault: String) -> Resolution {
    let fallback = Resolution(path: repoDefault, isExplicit: false)
    guard let raw = environment[environmentKey], !raw.isEmpty, !raw.contains("$(") else {
      return fallback
    }
    let path = URL(fileURLWithPath: raw).standardizedFileURL.path
    return path == URL(fileURLWithPath: repoDefault).standardizedFileURL.path
      ? fallback
      : Resolution(path: path, isExplicit: true)
  }

  /// Pure: what to do when `fixturePath` is not on disk.
  static func verdict(missing fixturePath: String, resolution: Resolution) -> MissingVerdict {
    resolution.isExplicit
      ? .fail(
        "UITest fixture missing at the EXPLICIT \(environmentKey)=\(resolution.path): \(fixturePath)")
      : .skip(
        "UITest fixture missing: \(fixturePath) — no \(environmentKey) named a root, "
          + "so this is the repo default; provision test-fixtures/raws/ or set "
          + "TEST_RUNNER_\(environmentKey) in the xcodebuild environment.")
  }

  /// The runner-side resolution for this process.
  static func current() -> Resolution {
    resolve(environment: ProcessInfo.processInfo.environment, repoDefault: repoDefault())
  }

  /// Locate `fixture` (a basename) under the resolved root. Throws `XCTSkip`
  /// when it is absent at the repo default; records a failure and throws
  /// when it is absent at an explicitly named root.
  static func locate(
    _ fixture: String, file: StaticString = #filePath, line: UInt = #line
  ) throws -> URL {
    let resolution = current()
    let url = URL(fileURLWithPath: resolution.path).appendingPathComponent(fixture)
    guard !FileManager.default.fileExists(atPath: url.path) else { return url }
    switch verdict(missing: url.path, resolution: resolution) {
    case .skip(let reason):
      throw XCTSkip(reason, file: file, line: line)
    case .fail(let reason):
      XCTFail(reason, file: file, line: line)
      throw MissingFixture(path: url.path)
    }
  }

  struct MissingFixture: Error {
    let path: String
  }
}
