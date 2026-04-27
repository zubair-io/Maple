// SMBSource.swift — SMB 2/3 source adapter via AMSMB2.
//
// Provides read access to RAW files on an SMB share (NAS / Samba server).
// XMP sidecar writes are retried with exponential back-off.
//
// The listing call recursively walks the connected share root and surfaces
// every RAW file regardless of folder depth, because the typical NAS layout
// is `/Photos/<event>/<file>.dng` and a non-recursive root scan returns
// nothing on shares that contain only sub-folders at the top level.
//
// AMSMB2 v4 API notes:
//   - contentsOfDirectory returns [[URLResourceKey: Any]] — use .nameKey, .isDirectoryKey, .pathKey
//   - contents(atPath:range:) returns Data directly
//   - write(data:toPath:progress:) async throws
//   - disconnectShare(gracefully:) async throws
//
// AMSMB2 license: MIT (review before App Store submission).

import Foundation
import AMSMB2

// MARK: - SMBSource

/// Access RAW files on an SMB 2/3 share.
public actor SMBSource {

    // MARK: Types

    public struct SMBAsset: Sendable, Identifiable, Hashable {
        public let id: UUID
        public let path: String       // share-relative path, e.g. "/Photos/IMG_001.dng"
        public var name: String { (path as NSString).lastPathComponent }

        public init(path: String) {
            self.id = UUID()
            self.path = path
        }
    }

    public struct Credentials: Sendable {
        public let host: String
        public let share: String
        public let username: String
        public let password: String

        public init(host: String, share: String, username: String, password: String) {
            self.host = host
            self.share = share
            self.username = username
            self.password = password
        }
    }

    // MARK: State

    private var client: SMB2Manager?
    private var credentials: Credentials?
    private var _assets: [SMBAsset] = []

    public var assets: [SMBAsset] { _assets }

    public init() {}

    // MARK: Public API

    /// Connect to an SMB share and enumerate RAW files in a path.
    public func connect(credentials: Credentials, remotePath: String = "/") async throws {
        self.credentials = credentials

        guard let serverURL = URL(string: "smb://\(credentials.host)") else {
            throw SMBError.invalidServerURL(credentials.host)
        }

        let cred = URLCredential(
            user: credentials.username,
            password: credentials.password,
            persistence: .forSession
        )
        guard let mgr = SMB2Manager(url: serverURL, credential: cred) else {
            throw SMBError.invalidServerURL(credentials.host)
        }

        try await mgr.connectShare(name: credentials.share)
        self.client = mgr
        _assets = try await listRAWFiles(at: remotePath, client: mgr)
    }

    /// Disconnect from the share.
    public func disconnect() async {
        try? await client?.disconnectShare(gracefully: false)
        client = nil
    }

    /// Read raw bytes of an asset over SMB.
    public func rawData(for asset: SMBAsset) async throws -> Data {
        guard let client else { throw SMBError.notConnected }
        return try await client.contents(atPath: asset.path, range: Range<UInt64>?.none)
    }

    /// Write XMP sidecar bytes over SMB with retry (3 attempts, exponential back-off).
    public func writeSidecar(_ data: Data, for asset: SMBAsset) async throws {
        guard let client else { throw SMBError.notConnected }
        let sidecarPath = (asset.path as NSString)
            .deletingPathExtension
            .appending(".xmp")
        try await writeWithRetry(data: data, to: sidecarPath, client: client)
    }

    // MARK: Private

    /// Recursively enumerate RAW files under `path`. AMSMB2's `recursive: true`
    /// flag walks the whole subtree in one round-trip and stamps each entry's
    /// `.pathKey` with its full share-relative path (e.g.
    /// `/Photos/2024/IMG_001.dng`). Directories and dotfiles are skipped.
    ///
    /// Recursive enumeration matches the user's expectation that "open the
    /// share, see all my photos" works regardless of whether the RAWs sit at
    /// the share root or three folders deep — the prior non-recursive walk
    /// returned an empty list whenever the root contained only sub-folders,
    /// which is the common NAS layout (`/Photos/`, `/Backups/`, etc.).
    private func listRAWFiles(at path: String, client: SMB2Manager) async throws -> [SMBAsset] {
        let entries = try await client.contentsOfDirectory(atPath: path, recursive: true)
        return entries.compactMap { attrs -> SMBAsset? in
            guard let name = attrs[.nameKey] as? String else { return nil }
            // Skip dotfiles (`.DS_Store`, `.maple/`, etc.).
            if name.hasPrefix(".") { return nil }
            let isDir = attrs[.isDirectoryKey] as? Bool ?? false
            guard !isDir else { return nil }
            let ext = (name as NSString).pathExtension.lowercased()
            guard SupportedImageExtensions.all.contains(ext) else { return nil }
            // `.pathKey` is the full share-relative path stamped by AMSMB2's
            // recursive walk; fall back to joining `path + name` when the
            // server didn't populate it (non-recursive root scan).
            let fullPath = (attrs[.pathKey] as? String)
                ?? (path as NSString).appendingPathComponent(name)
            return SMBAsset(path: fullPath)
        }.sorted { $0.path < $1.path }
    }

    private func writeWithRetry(data: Data, to path: String, client: SMB2Manager,
                                maxAttempts: Int = 3) async throws {
        var lastError: Error?
        for attempt in 0..<maxAttempts {
            do {
                try await client.write(data: data, toPath: path, progress: nil)
                return
            } catch {
                lastError = error
                if attempt < maxAttempts - 1 {
                    let delay = UInt64(pow(2.0, Double(attempt))) * 1_000_000_000
                    try? await Task.sleep(nanoseconds: delay)
                }
            }
        }
        throw lastError ?? SMBError.writeFailedAfterRetries
    }
}

// MARK: - ImageSource conformance

extension SMBSource: ImageSource {
    /// Map enumerated `SMBAsset`s to `ImageRef`. `id` is the share-relative
    /// path (stable for the lifetime of this connection). `url` is left `nil`
    /// so `BrowseViewModel.loadSource` routes byte reads through
    /// `rawBytes(for:)` (the bytes-provider branch) — the Rust decode pipeline
    /// can't open an `smb://` URL as a file URL, so the prior synthetic URL
    /// caused decodes to fail silently downstream.
    public func images() async throws -> [ImageRef] {
        return _assets.map { a in
            ImageRef(id: a.path, displayName: a.name, url: nil)
        }
    }

    public func thumb(for ref: ImageRef) async throws -> Data? { nil }
    public func preview(for ref: ImageRef) async throws -> Data? { nil }

    public func rawBytes(for ref: ImageRef) async throws -> Data {
        guard let client else { throw SMBError.notConnected }
        return try await client.contents(atPath: ref.id, range: Range<UInt64>?.none)
    }

    public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        guard let client else { throw SMBError.notConnected }
        let xml = XMPSerializer.serialize(model: sidecar.model, culling: sidecar.culling)
        guard let data = xml.data(using: .utf8) else {
            throw XMPStoreError.encodingError
        }
        let sidecarPath = (ref.id as NSString)
            .deletingPathExtension
            .appending(".xmp")
        try await writeWithRetry(data: data, to: sidecarPath, client: client)
    }

    /// SMB shares have no server-side index.
    public func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}

// MARK: - SMBError

public enum SMBError: Error, LocalizedError {
    case invalidServerURL(String)
    case notConnected
    case writeFailedAfterRetries

    public var errorDescription: String? {
        switch self {
        case .invalidServerURL(let h):  return "Invalid SMB server URL: \(h)"
        case .notConnected:             return "Not connected to SMB share"
        case .writeFailedAfterRetries:  return "SMB sidecar write failed after retries"
        }
    }
}
