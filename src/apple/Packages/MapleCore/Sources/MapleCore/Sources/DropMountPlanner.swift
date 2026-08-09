// DropMountPlanner.swift — pure routing logic for OS file/folder drops onto
// the app window (#2649).
//
// Dropping is the same code path as "Open" — mount by reference, never copy
// (docs/spec/08-io.md § Import rules). This type only DECIDES what a drop
// should do; it performs no I/O beyond the injected `isDirectory` probe
// (defaulted to a real `URL.resourceValues` check, overridable in tests) so
// the four documented cases are unit-testable without a live SwiftUI
// hierarchy, a security-scoped bookmark, or a mounted `AppShell`:
//
//   • Drop a single file       → mount its parent folder, open that photo.
//   • Drop a folder            → mount the folder, land in Browse.
//   • Drop multiple loose files → mount their common parent, select them.
//   • Drop something already inside a mounted source → navigate/select,
//     no remount, no new bookmark.
//
// `AppShell+FolderDrop.swift` is the only caller — it resolves `DropPlan`
// into actual `loadFolder` / `openSubFolder` / selection calls and owns the
// security-scope + bookmark side effects this type deliberately has none of.

import Foundation

// MARK: - DropPlan

public enum DropPlan: Equatable {
    /// Single dropped file: mount `parentFolder` as a source, then open
    /// `file` in Full Image.
    case openFile(file: URL, parentFolder: URL)
    /// Single dropped folder: mount it as a source, land in Browse with
    /// nothing pre-selected.
    case mountFolder(URL)
    /// Multiple loose items dropped together: mount their common parent as
    /// a source, land in Browse with `files` selected.
    case mountAndSelect(parentFolder: URL, files: [URL])
    /// Every dropped item already lives under `root`, an already-mounted
    /// source — navigate there and select accordingly. No remount, no new
    /// bookmark. `items` are the raw dropped URLs (folders and/or files);
    /// the caller re-derives the navigation target the same way it would
    /// for a fresh mount (see `AppShell+FolderDrop.swift`).
    case navigateExisting(root: URL, items: [URL])
    /// Nothing dropped had a supported extension (and no folder was
    /// dropped either) — the caller must show why, not silently no-op.
    case unsupported(extensions: [String])
}

// MARK: - DropMountPlanner

public enum DropMountPlanner {
    /// Decide what an OS drop of `urls` onto the window should do.
    ///
    /// - Parameters:
    ///   - urls: file URLs resolved from the drop — folders or files, no
    ///     ordering guarantee.
    ///   - mountedRoots: absolute-path roots of every currently-known local
    ///     source (the active browse root plus every `SavedFolderStore`
    ///     entry) — used to detect "drop already inside a mounted source."
    ///     Pass `[]` to force a fresh-mount decision regardless of what's
    ///     already open (used internally by the caller to resolve the
    ///     navigation target inside `.navigateExisting`).
    ///   - isDirectory: injected filesystem probe so tests can supply
    ///     directory-ness without touching disk; defaults to a real check.
    public static func plan(
        for urls: [URL],
        mountedRoots: [URL],
        isDirectory: (URL) -> Bool = { url in
            (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        }
    ) -> DropPlan {
        guard !urls.isEmpty else { return .unsupported(extensions: []) }

        // A dropped folder together with one of its own descendants (e.g.
        // the folder AND a file inside it, both selected in Finder and
        // dragged together) collapses to just the folder — otherwise the
        // common-parent calc below lands one level too high (the folder's
        // OWN parent), which is unscoped and never what the user meant by
        // dragging the folder itself.
        let topLevel = reduceToTopLevel(urls)

        if let existingRoot = mountedRoots.first(where: { root in
            topLevel.allSatisfy { $0.isDescendant(ofOrEqualTo: root) }
        }) {
            return .navigateExisting(root: existingRoot, items: topLevel)
        }

        let folders = topLevel.filter(isDirectory)
        let files = topLevel.filter { !isDirectory($0) }

        // A single dropped folder mounts directly — no common-parent
        // computation needed, and nothing to select once landed in Browse.
        if folders.count == 1 && files.isEmpty {
            return .mountFolder(folders[0])
        }

        let supportedFiles = files.filter {
            SupportedImageExtensions.all.contains($0.pathExtension.lowercased())
        }
        let unsupportedExtensions = files
            .filter { !SupportedImageExtensions.all.contains($0.pathExtension.lowercased()) }
            .map { $0.pathExtension }

        // Folders are always valid mount targets in their own right (their
        // OWN path feeds the common-parent calc); only loose files can be
        // "unsupported."
        let targets = supportedFiles + folders
        guard !targets.isEmpty else {
            return .unsupported(extensions: Array(Set(unsupportedExtensions)).sorted())
        }
        guard let commonParent = URL.commonParent(of: targets) else {
            return .unsupported(extensions: Array(Set(unsupportedExtensions)).sorted())
        }

        if targets.count == 1, folders.isEmpty, let onlyFile = supportedFiles.first {
            return .openFile(file: onlyFile, parentFolder: commonParent)
        }

        return .mountAndSelect(parentFolder: commonParent, files: targets)
    }

    /// Drop any URL that is a descendant-or-equal of ANOTHER url in the same
    /// list — keeps only the "outermost" items. A dropped folder plus a
    /// file inside it collapses to just the folder; a dropped folder plus
    /// its own subfolder collapses to just the outer folder. Order-
    /// independent and stable for duplicate entries (an exact duplicate
    /// URL never removes itself, since `other != candidate` requires a
    /// genuinely different value).
    private static func reduceToTopLevel(_ urls: [URL]) -> [URL] {
        urls.filter { candidate in
            !urls.contains { other in
                other != candidate && candidate.isDescendant(ofOrEqualTo: other)
            }
        }
    }
}
