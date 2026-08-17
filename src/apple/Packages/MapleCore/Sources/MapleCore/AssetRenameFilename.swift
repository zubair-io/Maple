// AssetRenameFilename.swift — pure filename derivation shared by every
// rename surface (single-asset #2638/#2842, batch #2641). Split out so the
// stem/extension logic has ONE implementation and ONE set of tests instead
// of drifting between `AssetFilenameRow` (Info panel), the Browse grid's
// inline-rename affordance, and `BatchRenameViewModel` — which previously
// each carried their own copy of `fullFilename`, flagged as duplication in
// the batch-rename ticket's own comment ("Matches the single-asset rename
// ticket's identical helper") but never consolidated until now.

import Foundation

extension AssetRef {
    /// The full on-disk / catalog filename (stem + extension).
    /// `AssetRef.displayName` is inconsistent about including the
    /// extension — stripped for `primaryURL`-backed refs (Filesystem),
    /// included as-is for bytes-backed refs (SMB/Cloud/PhotoKit, which pass
    /// the raw source filename straight through as `displayNameOverride`) —
    /// so this resolves the URL case explicitly rather than re-appending a
    /// guessed extension.
    public var fullFilename: String {
        if let url = primaryURL {
            return url.lastPathComponent
        }
        return displayName
    }
}

/// Grouped under a caseless enum purely so the derivation has a
/// discoverable name, matching `RevealInFileManagerSelection`.
public enum AssetRenameFilename {
    /// `true` when `newFilename`'s extension differs from
    /// `originalFilename`'s, case-insensitively. An original with NO
    /// extension never reports a change here — there's nothing to warn
    /// about preserving — matching every rename surface's existing
    /// "warn but allow" gate: the extension-change confirmation only fires
    /// when there was a real extension to lose.
    public static func extensionChanged(from originalFilename: String, to newFilename: String) -> Bool {
        let originalExt = (originalFilename as NSString).pathExtension.lowercased()
        guard !originalExt.isEmpty else { return false }
        let newExt = (newFilename as NSString).pathExtension.lowercased()
        return newExt != originalExt
    }
}
