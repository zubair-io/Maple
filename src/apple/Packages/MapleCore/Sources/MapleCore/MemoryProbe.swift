// MemoryProbe.swift — #1647 (M1) — on-device memory instrumentation.
//
// iOS device logs are not capturable from a headless host (see GpuLiveDriver's
// onError note), so this probe appends a footprint trace to a file in the app's
// Documents container that the harness pulls via `devicectl ... copy from
// --domain-type appDataContainer`. Gated by `MAPLE_MEM_PROBE=1` so it is inert
// in normal runs (no file I/O on the render path).
//
// Two metrics per sample:
//   • phys_footprint  — the value iOS jetsam compares against the per-process
//     limit (Mach `task_vm_info`). This is "how close to the kill ceiling".
//   • available       — `os_proc_available_memory()`, bytes the app may still
//     allocate before its limit (0 once over). Advisory (Apple), but the live
//     headroom signal we want for tuning the M1 resolution cap.
//
// When enabled it ALSO forces the GPU-live path on regardless of sensor size
// (see `EditSession+GpuLive`), so the large-RAW GPU footprint can be measured
// even though the production gate would route it to CPU.

import Foundation
import os
// `task_info` / `task_vm_info_data_t` / `mach_task_self_` / `TASK_VM_INFO` live in
// the Darwin (Mach) module — import it explicitly rather than rely on Foundation
// re-exporting it.
import Darwin

public enum MemoryProbe {
    /// `MAPLE_MEM_PROBE=1` at launch. Read once; never re-read on the render path.
    public static let isEnabled: Bool =
        ProcessInfo.processInfo.environment["MAPLE_MEM_PROBE"] == "1"

    private static let fileURL: URL? = {
        guard isEnabled else { return nil }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        return docs?.appendingPathComponent("mem-probe.log")
    }()

    /// Append `<phase> footprint=<MB> avail=<MB>` for one render-pipeline phase.
    /// No-op unless `MAPLE_MEM_PROBE=1`.
    public static func sample(_ phase: String) {
        guard isEnabled, let fileURL else { return }
        let foot = Double(physFootprintBytes()) / 1_048_576.0
        // `os_proc_available_memory()` is iOS-only; -1 on macOS (probe runs on
        // device — the macOS build just needs to compile).
        #if os(iOS)
        let avail = Double(os_proc_available_memory()) / 1_048_576.0
        #else
        let avail = -1.0
        #endif
        let line = String(format: "%@ footprint=%.0fMB avail=%.0fMB\n", phase, foot, avail)
        append(line, to: fileURL)
    }

    private static func physFootprintBytes() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) { ptr -> kern_return_t in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return kr == KERN_SUCCESS ? UInt64(info.phys_footprint) : 0
    }

    private static func append(_ line: String, to url: URL) {
        guard let data = line.data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }
}
