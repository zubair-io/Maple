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
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §11.

import Foundation

// MARK: - AppSupportSidecarStoreError

/// Errors thrown by `AppSupportSidecarStore.read(phassetLocalId:)`.
public enum AppSupportSidecarStoreError: Error, LocalizedError, Sendable {
    /// The sidecar file exists but its bytes are not valid UTF-8.
    case decodeFailed(URL)

    public var errorDescription: String? {
        switch self {
        case .decodeFailed(let url):
            return "PhotoKit sidecar at \(url.lastPathComponent) is not valid UTF-8"
        }
    }
}

// MARK: -

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
    /// unintended subdirectories. Replace `/` → `_`.
    ///
    /// Apple's documented identifier format uses dashed hex UUIDs and an
    /// `/Lx/yyy` suffix, neither of which contain `_`, so the transform is
    /// reversible IN PRACTICE for Apple-supplied identifiers. We don't rely
    /// on the reverse direction — the raw identifier is also stored inside
    /// the XMP payload (`maple:phassetLocalId`), which is the canonical
    /// round-trip source.
    private func url(for phassetLocalId: String) -> URL {
        let safe = phassetLocalId.replacingOccurrences(of: "/", with: "_")
        return root.appendingPathComponent("\(safe).xmp")
    }

    /// Read the sidecar for `phassetLocalId`.
    ///
    /// Returns `nil` when no sidecar file exists for this identifier.
    /// Throws `AppSupportSidecarStoreError.decodeFailed` when the file exists
    /// but its bytes cannot be decoded as UTF-8 — callers should treat this
    /// as a corruption signal rather than silently falling back to defaults,
    /// which would discard the user's edits.
    public func read(phassetLocalId: String) throws -> String? {
        let u = url(for: phassetLocalId)
        guard FileManager.default.fileExists(atPath: u.path) else { return nil }
        let data = try Data(contentsOf: u)
        guard let s = String(data: data, encoding: .utf8) else {
            throw AppSupportSidecarStoreError.decodeFailed(u)
        }
        return s
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
