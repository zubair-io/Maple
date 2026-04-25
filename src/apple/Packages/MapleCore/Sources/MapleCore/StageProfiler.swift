// StageProfiler.swift — terminal-friendly per-stage timing for the Apple
// open path, gated on the same `MAPLE_PROFILE` environment variable as
// the Rust `stage()` helper in `raw-core`.
//
// When `MAPLE_PROFILE` is set, every wrapped call emits one stderr line
// in the format `[swift] <name>            <elapsed>` (30-char name +
// 10-char duration column, matching the raw-core layout so a single
// `MAPLE_PROFILE=1` run produces interleaved Swift and Rust timings
// that line up visually).
//
// When unset the only cost is one `ProcessInfo.environment` lookup —
// the StaticString name isn't allocated, the closure isn't timed, the
// Duration isn't formatted. Negligible relative to the per-pixel work
// the wrappers sit in front of, so we leave them on in release builds
// and let the env var gate the actual output.
//
// Why stderr instead of `os_log` / `OSSignposter`: the latter feeds
// Instruments, which is the right tool for an interactive timeline
// view. This helper is for the developer who's tailing the Xcode
// console (or a TTY) and wants to see "where did those 12 seconds
// go" in plain text. Both are wired today; pick whichever matches
// the debugging surface you're on.
//
// Note on activation: any value of `MAPLE_PROFILE` enables logging
// (existence-gated, not value-gated). `MAPLE_PROFILE=0` and
// `MAPLE_PROFILE=` both turn it on. `unset MAPLE_PROFILE` is the
// only way to disable.

import Foundation

/// Time a synchronous closure. When `MAPLE_PROFILE` is set in the
/// environment, emits one stderr line with the elapsed wall time.
@inline(__always)
func mapleStage<T>(
    _ name: StaticString,
    _ work: () throws -> T
) rethrows -> T {
    guard ProcessInfo.processInfo.environment["MAPLE_PROFILE"] != nil else {
        return try work()
    }
    let start = DispatchTime.now()
    let result = try work()
    StageProfiler.emit(
        name: name,
        nanoseconds: DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds
    )
    return result
}

/// Time an asynchronous closure. Same env-var gate as `mapleStage`.
@inline(__always)
func mapleStageAsync<T>(
    _ name: StaticString,
    _ work: () async throws -> T
) async rethrows -> T {
    guard ProcessInfo.processInfo.environment["MAPLE_PROFILE"] != nil else {
        return try await work()
    }
    let start = DispatchTime.now()
    let result = try await work()
    StageProfiler.emit(
        name: name,
        nanoseconds: DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds
    )
    return result
}

private enum StageProfiler {
    static func emit(name: StaticString, nanoseconds: UInt64) {
        let nameStr = "\(name)"
        let paddedName: String = nameStr.count < 30
            ? nameStr + String(repeating: " ", count: 30 - nameStr.count)
            : nameStr
        let formatted = formatNanos(nanoseconds)
        let alignedDuration: String = formatted.count < 10
            ? String(repeating: " ", count: 10 - formatted.count) + formatted
            : formatted
        let line = "[swift] \(paddedName) \(alignedDuration)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }

    /// Format an elapsed-nanoseconds value the same way Rust's
    /// `Duration::Debug` does — `1.23ns`, `4.56µs`, `7.89ms`, `1.23s`.
    /// Keeps the Swift and Rust output columns visually consistent.
    static func formatNanos(_ nanos: UInt64) -> String {
        if nanos < 1_000 { return "\(nanos)ns" }
        if nanos < 1_000_000 {
            return String(format: "%.2fµs", Double(nanos) / 1_000)
        }
        if nanos < 1_000_000_000 {
            return String(format: "%.2fms", Double(nanos) / 1_000_000)
        }
        return String(format: "%.2fs", Double(nanos) / 1_000_000_000)
    }
}
