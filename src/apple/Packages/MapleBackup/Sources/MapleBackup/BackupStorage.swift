import Foundation

/// Where the backup engine keeps its per-device state — the device id, the
/// PhotoKit sidecar store and the per-destination state database. Resolved
/// inside the shared App Group container so the app, the macOS backup
/// helper and the iOS background task all see ONE copy (#4717); before this
/// each process used its own Application Support and the helper never found
/// the settings or state the app had written. Whatever the old per-process
/// location already holds is moved across once.
public enum BackupStorage {
    public static let appGroupID = "group.app.justmaple.aperture"

    public static func sharedRoot() throws -> URL {
        let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupID)
        return try resolveRoot(container: container, legacy: try legacyRoot())
    }

    /// `~/Library/Application Support/Maple` for this process — the
    /// pre-#4717 location, kept as the fallback when no App Group container
    /// is available.
    public static func legacyRoot() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        return appSupport.appendingPathComponent("Maple", isDirectory: true)
    }

    /// A process without the App Group entitlement (the SwiftPM test
    /// runner, a stray dev build) is still handed a container URL on macOS
    /// but cannot write under it; that counts as "no container" and keeps
    /// the legacy per-process location.
    public static func resolveRoot(container: URL?, legacy: URL) throws -> URL {
        let fm = FileManager.default
        guard let container,
            let root = Optional(container.appendingPathComponent("Maple", isDirectory: true)),
            (try? fm.createDirectory(at: root, withIntermediateDirectories: true)) != nil
        else {
            try fm.createDirectory(at: legacy, withIntermediateDirectories: true)
            return legacy
        }
        try migrate(from: legacy, to: root)
        return root
    }

    public static func stateDatabaseURL(in root: URL, filename: String) -> URL {
        root.appendingPathComponent(filename)
    }

    private static func isBackupState(_ name: String) -> Bool {
        name == "device-id" || name == "PhotoKitSidecars"
            || (name.hasPrefix("backup-state-") && name.hasSuffix(".sqlite"))
    }

    /// Moves (never copies) each backup-state entry the old location still
    /// holds, and only where the shared root has nothing yet — a second
    /// process that already migrated wins, and nothing reappearing at the
    /// old path can clobber it.
    private static func migrate(from legacy: URL, to root: URL) throws {
        let fm = FileManager.default
        guard legacy.standardizedFileURL != root.standardizedFileURL,
            let names = try? fm.contentsOfDirectory(atPath: legacy.path)
        else { return }
        for name in names where isBackupState(name) {
            let destination = root.appendingPathComponent(name)
            guard !fm.fileExists(atPath: destination.path) else { continue }
            try fm.moveItem(at: legacy.appendingPathComponent(name), to: destination)
        }
    }
}
