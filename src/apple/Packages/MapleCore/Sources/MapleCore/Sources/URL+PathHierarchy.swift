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
    /// standardized path components, LOWERCASED before comparing — APFS
    /// (macOS's default volume format) is case-insensitive-but-case-
    /// preserving, so "/Users/x/Photos" and "/Users/x/photos" name the same
    /// on-disk directory even though the strings differ. A dropped item
    /// resolved through Finder/a bookmark can come back with either casing
    /// depending on how it was originally typed, so a case-SENSITIVE
    /// component compare here would miss a genuine "already mounted" match.
    public func isDescendant(ofOrEqualTo other: URL) -> Bool {
        let selfComponents = standardizedFileURL.pathComponents.map { $0.lowercased() }
        let otherComponents = other.standardizedFileURL.pathComponents.map { $0.lowercased() }
        guard otherComponents.count <= selfComponents.count else { return false }
        return Array(selfComponents.prefix(otherComponents.count)) == otherComponents
    }

    /// Deepest folder that contains every URL in `urls` — computed from each
    /// URL's own parent directory (`deletingLastPathComponent()`), so a
    /// dropped folder counts by its own path, not one level up from it.
    /// `nil` only for an empty list.
    ///
    /// The shared-prefix walk compares LOWERCASED components — same APFS
    /// case-insensitive-but-case-preserving reasoning as
    /// `isDescendant(ofOrEqualTo:)` above. Comparing case-sensitively here
    /// would make two differently-cased spellings of the SAME real
    /// directory look like a divergence, terminating the shared prefix
    /// early — worst case collapsing the "common parent" all the way to
    /// `/` and asking the user to grant scope over the entire filesystem
    /// (#2756 review finding B1). `common` itself keeps the ORIGINAL
    /// (non-lowercased) components — only the comparison is
    /// case-normalized — so the returned URL preserves whatever casing the
    /// first-encountered spelling used.
    public static func commonParent(of urls: [URL]) -> URL? {
        guard let first = urls.first else { return nil }
        var common = first.standardizedFileURL.deletingLastPathComponent().pathComponents
        for url in urls.dropFirst() {
            let components = url.standardizedFileURL.deletingLastPathComponent().pathComponents
            let sharedCount = zip(common, components)
                .prefix { $0.lowercased() == $1.lowercased() }
                .count
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
