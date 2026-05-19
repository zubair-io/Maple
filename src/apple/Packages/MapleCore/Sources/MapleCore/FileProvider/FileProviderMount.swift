// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMount.swift
import FileProvider
import Foundation

/// Helpers for resolving the Maple app's view of File Provider state:
/// looking up the registered FP domain for a server URL, and translating a
/// server-side `AssetMetadata.absPath` into the user-visible local URL the
/// OS materialises into `~/Library/CloudStorage/<DisplayName>/`.
///
/// Both helpers return `nil` for "feature not available" cases so the
/// caller can fall back to the existing direct-API path without
/// distinguishing "user hasn't enabled File Sync" from "FP domain in a
/// broken state". Genuine I/O failures surface as thrown errors.
public struct FileProviderMount {
    /// Look up the FP domain registered with the OS for `serverURL`.
    ///
    /// Returns `nil` when:
    ///   - the URL is hostless (`file://` etc.), or
    ///   - the user hasn't enabled File Sync for that server (no domain
    ///     with the canonical identifier is present in
    ///     `NSFileProviderManager.domains()`).
    ///
    /// Throws if `NSFileProviderManager.domains()` itself fails.
    public static func domain(forServer serverURL: URL) async throws -> NSFileProviderDomain? {
        guard let idString = FileProviderDomainController.domainIdentifier(for: serverURL) else {
            return nil
        }
        let identifier = NSFileProviderDomainIdentifier(idString)
        let domains = try await NSFileProviderManager.domains()
        return domains.first { $0.identifier == identifier }
    }

    /// Resolve the user-visible local URL for an asset, via the FP mount.
    ///
    /// Returns `nil` when:
    ///   - `NSFileProviderManager(for: domain)` returns nil (domain
    ///     registered but the OS can't construct a manager — typically a
    ///     transient state during disable/enable cycling), or
    ///   - the asset's `absPath` doesn't fall under the library root's
    ///     `path` (defensive against drift between the server's view of
    ///     the library and the client's cached `LibraryRoot`).
    ///
    /// Throws when `getUserVisibleURL(for: .rootContainer)` fails (dormant
    /// domain, missing keychain entitlement, etc.) — the caller should
    /// fall back to the direct-API path.
    public static func localURL(
        forAsset asset: AssetMetadata,
        root: LibraryRoot,
        domain: NSFileProviderDomain
    ) async throws -> URL? {
        guard let mgr = NSFileProviderManager(for: domain) else { return nil }
        let mountURL = try await mgr.getUserVisibleURL(for: .rootContainer)
        return composePath(
            mountURL: mountURL,
            rootLabel: root.label,
            absPath: asset.absPath,
            rootPath: root.path
        )
    }

    /// Pure path composition shared between `localURL(forAsset:root:domain:)`
    /// and tests. Splits `absPath` into its relative tail under `rootPath`
    /// and appends each component individually so that
    /// `URL.appendingPathComponent`'s behaviour with embedded slashes
    /// doesn't matter — the relative `"a/b/c.dng"` becomes three real
    /// `appendingPathComponent` calls on the OS's NSURL machinery.
    ///
    /// Returns `nil` when:
    ///   - `absPath` is empty,
    ///   - `rootPath` is empty (caller passed a malformed `LibraryRoot`), or
    ///   - `absPath` doesn't begin with `rootPath` (followed by `/` or
    ///     equal — but an asset whose absPath equals the root has no
    ///     filename and is rejected here for the same reason).
    static func composePath(
        mountURL: URL,
        rootLabel: String,
        absPath: String,
        rootPath: String
    ) -> URL? {
        guard let relative = relativePath(under: rootPath, of: absPath),
              !relative.isEmpty
        else { return nil }
        var url = mountURL.appendingPathComponent(rootLabel, isDirectory: true)
        let parts = relative.split(separator: "/", omittingEmptySubsequences: true)
        for (i, part) in parts.enumerated() {
            url = url.appendingPathComponent(String(part), isDirectory: i < parts.count - 1)
        }
        return url
    }

    /// Strip a library-root prefix off an absolute path, returning the
    /// relative tail. Returns `nil` when `absPath` doesn't fall under
    /// `rootPath`. Mirrors the prefix-strip used by
    /// `FileProviderExtensionCore.resolveAssetParent`:
    ///   - normalises `rootPath` to end in `/` so the prefix match doesn't
    ///     accept `"/srv/photos/LibraryB"` as a prefix of `"/srv/photos/Library/…"`,
    ///   - rejects empty inputs defensively.
    static func relativePath(under rootPath: String, of absPath: String) -> String? {
        guard !absPath.isEmpty, !rootPath.isEmpty else { return nil }
        let rootWithSlash = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard absPath.hasPrefix(rootWithSlash) else { return nil }
        return String(absPath.dropFirst(rootWithSlash.count))
    }
}
