// AppSupportSidecarStore.swift
//
// File-per-PHAsset `.xmp` sidecar store. Same on-disk format as
// `XMPSidecarStore` in MapleCore — just keyed by `phassetLocalId` instead of
// by raw file URL. Atomic writes via temp + `replaceItemAt`.
//
// This store holds Maple edits for PhotoKit-backed photos whose bytes
// haven't been uploaded yet. Once the BackupEngine uploads the bytes,
// the sidecar is copied to the cloud library as a normal `<file>.xmp`
// next to the asset, then the local row is deleted.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §11.

import Foundation

public final class AppSupportSidecarStore {

    /// Default location at
    /// `~/Library/Application Support/Maple/PhotoKitSidecars/`.
    /// Creates the directory if missing.
    public static func defaultRoot() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true)
        let dir = appSupport
            .appendingPathComponent("Maple", isDirectory: true)
            .appendingPathComponent("PhotoKitSidecars", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private let root: URL

    public init(root: URL) {
        self.root = root
    }

    /// PHAsset `localIdentifier` strings look like
    /// "BFBBE32B-2C39-43A5-B7FC-1E9BC0577CFE/L0/001" — slashes would create
    /// unintended subdirectories. Replace with `_`. The transform is
    /// reversible; callers that need the raw identifier read it back from
    /// the sidecar XML payload.
    private func url(for phassetLocalId: String) -> URL {
        let safe = phassetLocalId.replacingOccurrences(of: "/", with: "_")
        return root.appendingPathComponent("\(safe).xmp")
    }

    public func read(phassetLocalId: String) throws -> String? {
        let u = url(for: phassetLocalId)
        guard FileManager.default.fileExists(atPath: u.path) else { return nil }
        let data = try Data(contentsOf: u)
        return String(data: data, encoding: .utf8)
    }

    /// Atomic write: temp file → `replaceItemAt`. Overwrites any existing
    /// row at the same key. Leaves no orphan `.tmp` files on success.
    public func write(phassetLocalId: String, xmp: String) throws {
        let final = url(for: phassetLocalId)
        let tmp = final.deletingLastPathComponent()
            .appendingPathComponent(".\(final.lastPathComponent).tmp")
        try Data(xmp.utf8).write(to: tmp, options: .atomic)
        do {
            _ = try FileManager.default.replaceItemAt(final, withItemAt: tmp)
        } catch {
            // If replaceItemAt fails, clean up the temp so we don't leave
            // it behind, then rethrow.
            try? FileManager.default.removeItem(at: tmp)
            throw error
        }
    }

    /// Idempotent — a delete on a missing key is a no-op.
    public func delete(phassetLocalId: String) throws {
        let u = url(for: phassetLocalId)
        if FileManager.default.fileExists(atPath: u.path) {
            try FileManager.default.removeItem(at: u)
        }
    }
}

// Test-only accessor: lets in-package tests inspect the root URL without
// exposing it publicly. Phase 2 Task 2.12's BackupEngine test wires this up.
extension AppSupportSidecarStore {
    internal var rootForTesting: URL { root }
}
