import Darwin
import Foundation
import GRDB

/// Shared by the app and closed-app helper. Legacy data remains intact for recovery.
public enum BackupStorage {
  public static let appGroup = "group.app.justmaple.aperture"

  public static func defaultRoot() throws -> URL {
    guard
      let group = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup)
    else { throw CocoaError(.fileNoSuchFile) }
    let legacy = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true
    ).appendingPathComponent("Maple")
    return try migrate(groupRoot: group, legacyRoot: legacy)
  }

  /// Serialize first settings publication across app instances after storage is ready.
  public static func withSettingsLock<T>(_ body: () throws -> T) throws -> T {
    try withLock(at: defaultRoot(), name: ".backup-settings.lock", body)
  }

  static func withLock<T>(
    at root: URL, name: String = ".backup-storage.lock", _ body: () throws -> T
  ) throws -> T {
    let fd = open(root.appendingPathComponent(name).path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(fd) }
    guard flock(fd, LOCK_EX) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    defer { flock(fd, LOCK_UN) }
    return try body()
  }

  static func migrate(groupRoot: URL, legacyRoot: URL) throws -> URL {
    let fm = FileManager.default
    let root = groupRoot.appendingPathComponent("Maple", isDirectory: true)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    return try withLock(at: root) {
      let marker = root.appendingPathComponent(".backup-storage-v1")
      guard !fm.fileExists(atPath: marker.path) else { return root }
      let names =
        fm.fileExists(atPath: legacyRoot.path)
        ? try fm.contentsOfDirectory(atPath: legacyRoot.path) : []
      for name in names
      where name == "device-id" || name == "PhotoKitSidecars"
        || (name.hasPrefix("backup-state") && name.hasSuffix(".sqlite"))
      {
        let destination = root.appendingPathComponent(name)
        guard !fm.fileExists(atPath: destination.path) else { continue }
        let source = legacyRoot.appendingPathComponent(name)
        let staging = root.appendingPathComponent(".migration-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: staging) }
        if name.hasSuffix(".sqlite") {
          // SQLite's backup API includes committed WAL pages; copying the main file loses them.
          var config = Configuration()
          config.readonly = true
          let reader = try DatabaseQueue(path: source.path, configuration: config)
          let writer = try DatabaseQueue(path: staging.path)
          try reader.backup(to: writer)
          try writer.close()
          try reader.close()
        } else {
          try fm.copyItem(at: source, to: staging)
        }
        try fm.moveItem(at: staging, to: destination)
      }
      try Data().write(to: marker, options: .atomic)
      return root
    }
  }
}
