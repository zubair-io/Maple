// SMBFileOperations+Listing.swift — per-directory subfolder listing for the
// SMB source-tree sidebar (#2697).
//
// `SMBSource.images()` still walks the whole share recursively
// (`contentsOfDirectory(atPath:recursive: true)`) for the browse grid —
// that's unchanged. This is a SEPARATE, non-recursive per-directory call so
// the sidebar can lazily expand an SMB subfolder tree the same way the
// local Filesystem (`FolderTreeRow`) and Cloud (`CloudFolderTreeRow`)
// sources already do, without paying for a full-share walk on every
// sidebar expand. It's what gives Rename/Move to Trash a subfolder row to
// attach to — see `AppShell+FolderContextMenu.swift`'s file header.

import Foundation

extension SMBFileOperations {

    /// One subdirectory entry, as returned by a non-recursive directory
    /// listing.
    public struct DirEntry: Sendable, Hashable {
        public let name: String
        /// Share-relative path, e.g. `/Photos/2024`.
        public let path: String

        public init(name: String, path: String) {
            self.name = name
            self.path = path
        }
    }

    /// Direct (non-recursive) subdirectory listing of `path`. Dotfiles
    /// (`.maple`, `.DS_Store`) are excluded — same filter `SMBSource
    /// .listRAWFiles` applies to files. Sorted case-insensitively for a
    /// stable, human-friendly tree order.
    ///
    /// Self-filters to entries with no further path separator beyond
    /// `path`'s own prefix, rather than trusting the transport's
    /// `recursive: false` alone — defense in depth against a transport
    /// that doesn't honor the flag (the in-memory `FakeSMBTransport` used
    /// in tests is exactly that case: it has no non-recursive mode), and
    /// free correctness insurance against a server quirk on the real path
    /// too.
    public static func listSubdirectories(
        at path: String, transport: SMBFileTransport
    ) async throws -> [DirEntry] {
        let entries = try await transport.contentsOfDirectory(atPath: path, recursive: false)
        let prefix = path.hasSuffix("/") ? path : path + "/"
        return entries.compactMap { attrs -> DirEntry? in
            guard let name = attrs[.nameKey] as? String, !name.hasPrefix(".") else { return nil }
            guard (attrs[.isDirectoryKey] as? Bool) == true else { return nil }
            let fullPath = (attrs[.pathKey] as? String) ?? posixJoin(path, name)
            let relative = fullPath.hasPrefix(prefix) ? String(fullPath.dropFirst(prefix.count)) : name
            guard !relative.contains("/") else { return nil }
            return DirEntry(name: name, path: fullPath)
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
}
