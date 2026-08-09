// RevealInFileManagerSelection.swift — pure selection → URL derivation
// behind "Reveal in Finder" (#2658). Split out of BrowseGrid.swift (a
// SwiftUI view, not unit-testable via `swift test`) so the actual
// selection logic — which assets are eligible, and which URLs a
// multi-select reveal collects — gets the same kind of coverage
// RevealTarget.swift's derivation already has (RevealTargetTests.swift),
// matching the Windows sibling's dedicated `RevealInFileManagerLogic`
// + `RevealInFileManagerLogicTests`.

import Foundation

extension AssetRef {
    /// True only for a local-filesystem asset — the one case with a real
    /// on-disk `primaryURL` Finder can point at. PhotoKit assets live in
    /// the Photos library (no user-visible file), Cloud assets are
    /// server-resident (`catalog` set, `primaryURL` nil), and SMB assets
    /// are read over the network protocol directly (no local mount, so
    /// also `primaryURL` nil) — all three fall out of this check for free,
    /// the same way `RevealTarget`'s `.none` case does for PhotoKit.
    public var isRevealEligible: Bool { primaryURL != nil }
}

/// Grouped under a caseless enum purely so the derivation has a
/// discoverable name, matching how `RevealTarget` groups its own
/// `AssetRef` derivations.
public enum RevealInFileManagerSelection {
    /// The URLs a "Reveal in Finder" action on `ids` (drawn from `assets`)
    /// should hand to `NSWorkspace.activateFileViewerSelecting`. Ineligible
    /// assets (no `primaryURL` — PhotoKit, Cloud, SMB) are dropped rather
    /// than surfaced some other way; grid order (`assets`' order, not
    /// `ids`' iteration order — `ids` is a `Set`) is preserved so a
    /// multi-select reveal highlights items in the same order they appear
    /// in the grid. An all-ineligible (or empty) `ids` yields an empty
    /// array, which the call site reads as "nothing to reveal" — the same
    /// contract Windows' `RevealInFileManagerLogic.EligiblePaths`
    /// returning empty uses to hide "Show in Explorer" instead of showing
    /// it non-functional.
    public static func urls(for ids: Set<AssetRef.ID>, in assets: [AssetRef]) -> [URL] {
        assets.filter { ids.contains($0.id) }.compactMap(\.primaryURL)
    }
}
