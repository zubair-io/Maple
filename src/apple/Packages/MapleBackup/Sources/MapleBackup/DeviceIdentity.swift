// Sources/MapleBackup/DeviceIdentity.swift
//
// Stable UUID per device-and-app-install. Generated on first read and
// persisted to `storageURL` as plain UTF-8. The same UUID is sent to the
// server in every backup request as the `X-Maple-Device-Id` header so the
// server can attribute uploads to the right device (and so a single asset
// uploaded from two devices still collapses to one AssetDoc row via
// content-hash dedup — see spec §16).

import Foundation

public enum DeviceIdentity {

    /// Default storage at `~/Library/Application Support/Maple/device-id`.
    /// Creates the containing directory if missing.
    public static func defaultStorageURL() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true)
        let dir = appSupport.appendingPathComponent("Maple", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("device-id")
    }

    /// Read the persisted UUID at `storageURL`, or generate a fresh one on
    /// first call and atomic-write it. Subsequent reads round-trip the same
    /// value as long as the file is intact. A blank / whitespace-only file
    /// is treated as missing — the function generates a fresh UUID and
    /// overwrites the file.
    public static func current(storageURL: URL) throws -> String {
        if FileManager.default.fileExists(atPath: storageURL.path) {
            let data = try Data(contentsOf: storageURL)
            let s = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !s.isEmpty { return s }
        }
        let new = UUID().uuidString
        try Data(new.utf8).write(to: storageURL, options: .atomic)
        return new
    }
}
