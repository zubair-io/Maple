// RamdiskFixture.swift — a real, tiny HFS+ ramdisk for genuine ENOSPC
// tests (#2431's "disk-full states are deterministic and observable"
// acceptance criterion). No mocks: `hdiutil`/`diskutil` create an actual
// block device and an actual filesystem, so filling it produces a real
// `ENOSPC` from the real `FileManager`/`Data.write` calls the sidecar
// stores use — the same failure mode a user's full disk produces.
//
// Skip-passes (returns `nil` from `makeTiny()`) when `hdiutil` is
// unavailable — matches this repo's fixture-absence skip-pass convention
// (`docs/testing.md`) rather than failing CI in a sandboxed environment
// that can't attach block devices.

import Foundation

struct RamdiskFixture {
  let device: String
  let mountPoint: URL

  /// Creates a ~2 MB HFS+ ramdisk, mounted at `/Volumes/<name>`.
  static func makeTiny() -> RamdiskFixture? {
    guard let attachOutput = run("/usr/bin/hdiutil", ["attach", "-nomount", "ram://4096"]),
      let device = attachOutput.split(separator: "\n").last.map(String.init)?
        .trimmingCharacters(in: .whitespacesAndNewlines),
      device.hasPrefix("/dev/disk")
    else {
      return nil
    }
    let name = "SidecarContract\(UUID().uuidString.prefix(8))"
    guard run("/usr/sbin/diskutil", ["eraseVolume", "HFS+", name, device]) != nil else {
      _ = run("/usr/bin/hdiutil", ["detach", device])
      return nil
    }
    return RamdiskFixture(device: device, mountPoint: URL(fileURLWithPath: "/Volumes/\(name)"))
  }

  /// Writes filler bytes leaving well under 1 KB free — smaller than any
  /// real XMP sidecar, so the next sidecar write deterministically hits
  /// `ENOSPC` regardless of filesystem bookkeeping overhead.
  func fillToNearCapacity() throws {
    let attrs = try FileManager.default.attributesOfFileSystem(forPath: mountPoint.path)
    let free = (attrs[.systemFreeSize] as? NSNumber)?.intValue ?? 0
    let fillSize = max(0, free - 512)
    let fillerData = Data(count: fillSize)
    try fillerData.write(to: mountPoint.appendingPathComponent("filler.bin"))
  }

  /// Best-effort teardown: unmount the volume first (in case a just-closed
  /// file handle hasn't released the mount yet), then detach the device.
  /// One retry after a brief delay — `hdiutil detach` occasionally reports
  /// "resource busy" for a moment right after the last writer closes.
  func eject() {
    _ = Self.run("/usr/sbin/diskutil", ["unmount", "force", mountPoint.path])
    if Self.run("/usr/bin/hdiutil", ["detach", device, "-force"]) != nil { return }
    Thread.sleep(forTimeInterval: 0.5)
    _ = Self.run("/usr/sbin/diskutil", ["unmount", "force", mountPoint.path])
    _ = Self.run("/usr/bin/hdiutil", ["detach", device, "-force"])
  }

  private static func run(_ launchPath: String, _ arguments: [String]) -> String? {
    guard FileManager.default.isExecutableFile(atPath: launchPath) else { return nil }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    // Discard rather than pipe-and-never-read: an unread stderr `Pipe()`
    // can deadlock if the child writes enough to fill the OS pipe buffer
    // (it blocks on the write while this process blocks on
    // `readDataToEndOfFile()` for stdout) — jules review.
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
    } catch {
      return nil
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)
  }
}
