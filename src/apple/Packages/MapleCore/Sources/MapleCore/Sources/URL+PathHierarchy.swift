// URL+PathHierarchy.swift — pure path-hierarchy helpers used by the
// drop-to-mount planner (#2649) and available to any future caller that
// needs to reason about "is A inside B" / "deepest shared ancestor of
// these paths" without touching the filesystem.
//
// Compares STANDARDIZED path components, not raw strings — a `hasPrefix`
// check (the pattern `FilesystemSource.findScopedParent` uses today) would
// wrongly treat "/Users/x/PhotosOld" as inside "/Users/x/Photos".

import Foundation

extension URL {
    /// True when `self` is `other` or lives anywhere inside it, compared by
    /// standardized path components.
    public func isDescendant(ofOrEqualTo other: URL) -> Bool {
        let selfComponents = standardizedFileURL.pathComponents
        let otherComponents = other.standardizedFileURL.pathComponents
        guard otherComponents.count <= selfComponents.count else { return false }
        return Array(selfComponents.prefix(otherComponents.count)) == otherComponents
    }

    /// Deepest folder that contains every URL in `urls` — computed from each
    /// URL's own parent directory (`deletingLastPathComponent()`), so a
    /// dropped folder counts by its own path, not one level up from it.
    /// `nil` only for an empty list.
    public static func commonParent(of urls: [URL]) -> URL? {
        guard let first = urls.first else { return nil }
        var common = first.standardizedFileURL.deletingLastPathComponent().pathComponents
        for url in urls.dropFirst() {
            let components = url.standardizedFileURL.deletingLastPathComponent().pathComponents
            let sharedCount = zip(common, components).prefix { $0 == $1 }.count
            common = Array(common.prefix(sharedCount))
        }
        guard !common.isEmpty else { return nil }
        // `pathComponents` on an absolute URL starts with "/" — drop it, then
        // rebuild from the root so we don't double up the leading slash.
        var result = URL(fileURLWithPath: "/")
        for component in common.dropFirst() {
            result.appendPathComponent(component)
        }
        return result
    }
}
