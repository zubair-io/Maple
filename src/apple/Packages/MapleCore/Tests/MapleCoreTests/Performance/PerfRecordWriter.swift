// PerfRecordWriter.swift — writes a committed perf-table row (#3421).
//
// `EditorWorkflowPerfTests` already assembles every number this file
// records — cold-open latency, per-drag tick percentiles, export time. This
// file only adds the plumbing to (a) snapshot the device/environment the
// numbers came from and (b) serialize one row into the JSON file
// `tools/perf-table.py` renders into `docs/performance.md`, gated by
// `MAPLE_PERF_RECORD=<path>`. It measures nothing new — every value it
// writes is a parameter handed in by the caller.
//
// Opt-in by design: `recordIfRequested` no-ops unless `MAPLE_PERF_RECORD`
// is set, so a normal `MAPLE_PERF=1 swift test` run (no env var) behaves
// exactly as it did before this file existed.

import Darwin
import Foundation

#if canImport(Metal)
  import Metal
#endif
#if os(macOS)
  import AppKit
#endif

/// Static helpers for recording one `test-fixtures/perf/<platform>/<device>.json`
/// row from a perf test run. No XCTest dependency — pure Foundation/Darwin —
/// so it can be reused by any perf test in this target without pulling in
/// XCTest-specific plumbing.
enum PerfRecordWriter {
  /// Writes `row` into the JSON array at `MAPLE_PERF_RECORD`, replacing any
  /// existing row with the same `(fixture, profile, viewportWidth,
  /// viewportHeight)` key so a re-run overwrites its own prior entry instead
  /// of accumulating history. No-ops silently when the env var is unset —
  /// this is how the recorder stays opt-in.
  static func recordIfRequested(_ row: [String: Any]) {
    guard let path = ProcessInfo.processInfo.environment["MAPLE_PERF_RECORD"], !path.isEmpty
    else { return }
    let url = URL(fileURLWithPath: path)
    let fm = FileManager.default
    try? fm.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)

    var rows: [[String: Any]] = []
    if let data = try? Data(contentsOf: url),
      let existing = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    {
      rows = existing
    }
    func key(_ entry: [String: Any]) -> String {
      let fixture = "\(entry["fixture"] ?? "")"
      let profile = "\(entry["profile"] ?? "")"
      let width = "\(entry["viewportWidth"] ?? "")"
      let height = "\(entry["viewportHeight"] ?? "")"
      return "\(fixture)|\(profile)|\(width)|\(height)"
    }
    let newKey = key(row)
    rows.removeAll { key($0) == newKey }
    rows.append(row)
    rows.sort { key($0) < key($1) }

    guard
      let out = try? JSONSerialization.data(
        withJSONObject: rows, options: [.prettyPrinted, .sortedKeys])
    else { return }
    try? out.write(to: url, options: .atomic)
  }

  /// Hardware/OS facts captured at record time — device model, chip, GPU,
  /// OS version, display refresh rate and current thermal state. Everything
  /// here comes from a public API or `sysctlbyname`; nothing is shelled out
  /// except the commit sha (`gitCommitSha()` below), kept separate because a
  /// failed `Process` launch should never blank out the rest of the row.
  static func deviceSnapshot() -> [String: Any] {
    var info: [String: Any] = [:]
    info["deviceModel"] = sysctlString("hw.model") ?? "unknown"
    info["chip"] = sysctlString("machdep.cpu.brand_string") ?? "unknown"
    #if canImport(Metal)
      info["gpu"] = MTLCreateSystemDefaultDevice()?.name ?? "unknown"
    #else
      info["gpu"] = "unknown"
    #endif
    info["osVersion"] = ProcessInfo.processInfo.operatingSystemVersionString
    #if os(macOS)
      info["refreshRateHz"] = NSScreen.main?.maximumFramesPerSecond ?? 0
    #else
      info["refreshRateHz"] = 0
    #endif
    info["thermalState"] = thermalStateString(ProcessInfo.processInfo.thermalState)
    return info
  }

  /// A filesystem-safe device id for `test-fixtures/perf/<platform>/<id>.json`
  /// — the raw `hw.model` value (e.g. `Mac16,7`) with its comma swapped for
  /// a dash.
  static func deviceIdSlug(fromModel model: String) -> String {
    model.replacingOccurrences(of: ",", with: "-")
      .replacingOccurrences(of: " ", with: "_")
  }

  /// Best-effort `git rev-parse HEAD` against the repo root
  /// (`SliderTickPerfHarness.repoRoot()`). Returns `"unknown"` rather than
  /// throwing — a perf row missing a commit sha is still useful; a perf run
  /// that aborts because `/usr/bin/env` isn't where expected is not.
  static func gitCommitSha() -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git", "rev-parse", "HEAD"]
    process.currentDirectoryURL = SliderTickPerfHarness.repoRoot()
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()
    do {
      try process.run()
      process.waitUntilExit()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      let sha = String(decoding: data, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      return sha.isEmpty ? "unknown" : sha
    } catch {
      return "unknown"
    }
  }

  // MARK: - Private

  private static func sysctlString(_ name: String) -> String? {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    var buffer = [CChar](repeating: 0, count: size)
    guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
    return String(cString: buffer)
  }

  private static func thermalStateString(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }
}
