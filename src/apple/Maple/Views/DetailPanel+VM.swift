// DetailPanel+VM.swift — Pure-function view-model helpers for DetailPanel.
//
// Co-located sibling of DetailPanel.swift. Holds derivations and formatters
// that take typed inputs and return typed outputs — no SwiftUI, no @State,
// no view-builder closures. The view file calls these helpers and feeds the
// returned strings/structs into its body.
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation gets
// a sibling `+VM.swift` whose contents are unit-testable in isolation. To
// preserve that guarantee this file MUST NOT `import SwiftUI` — a grep gate
// in CI enforces it. If a helper needs `View` context it doesn't belong here.

import Foundation
import MapleCore

// MARK: - DetailPanelVM

/// Namespace for pure DetailPanel derivations. A caseless enum keeps the
/// helpers grouped without ever being instantiated. All members are static.
enum DetailPanelVM {

    /// The "Name" row in the Info tab prefers the on-disk filename when the
    /// asset is backed by a real URL, falls back to the display name for
    /// sourceless assets (PhotoKit / Self-Hosted), and finally to an em-dash
    /// when nothing is known. Mirrors the fallback chain that used to live
    /// inline inside the `body`.
    static func nameDisplay(for asset: AssetRef?) -> String {
        asset?.primaryURL?.lastPathComponent
            ?? asset?.displayName
            ?? "—"
    }

    /// Formats the as-shot CCT as kelvins with no decimal places — "5500 K".
    /// `nil` when the session has no CCT (non-RAW or unreadable metadata).
    static func formatAsShotCCT(_ cct: Double?) -> String? {
        guard let cct else { return nil }
        return String(format: "%.0f K", cct)
    }

    /// Formats the as-shot tint as a signed integer-ish string ("-5", "12").
    /// Uses the ASCII hyphen because `String(format: "%.0f", …)` renders
    /// the minus sign as `-` (U+002D), not the Unicode minus `−` (U+2212).
    /// `nil` when no tint is available.
    static func formatAsShotTint(_ tint: Double?) -> String? {
        guard let tint else { return nil }
        return String(format: "%.0f", tint)
    }

    /// Distinct section names in the order they first appear in `entries`.
    /// Avoids hard-coding section names so adding a new section in the EXIF
    /// reader surfaces it automatically.
    static func exifSections(from entries: [ImageMetadataReader.ExifEntry]) -> [String] {
        var seen: [String] = []
        for entry in entries where !seen.contains(entry.section) {
            seen.append(entry.section)
        }
        return seen
    }

    /// Off-main EXIF read for a given asset. Pulls bytes through the URL when
    /// available, otherwise through the asset's async `bytesProvider`. Returns
    /// `[]` when no source is available or the provider throws.
    ///
    /// Callers should write the result back into `@State` on the main actor
    /// AND re-check that the asset is still the active one (the user may have
    /// switched assets while bytes were fetching).
    static func loadExif(for asset: AssetRef) async -> [ImageMetadataReader.ExifEntry] {
        if let url = asset.primaryURL {
            return await Task.detached(priority: .userInitiated) {
                ImageMetadataReader.readExifProperties(from: url)
            }.value
        }
        if let provider = asset.bytesProvider {
            // Sourceless asset (PhotoKit, Self-Hosted). The provider call can
            // be expensive (network fetch) — keep it off main.
            let displayPath = asset.displayName
            return await Task.detached(priority: .userInitiated) { () -> [ImageMetadataReader.ExifEntry] in
                guard let data = try? await provider() else { return [] }
                return ImageMetadataReader.readExifProperties(
                    from: data,
                    byteCount: data.count,
                    displayPath: displayPath
                )
            }.value
        }
        return []
    }

    /// Tab to land on when the AppShell crosses the Browse↔Full-image
    /// boundary. Bug 4: opening the editor lands on Develop. Bug 5: leaving
    /// the editor lands on Info. The transition fires once per mode change,
    /// so the user can still pick the other tab manually within a mode.
    static func tabForFullImage(_ isFullImage: Bool) -> DetailPanel.PanelTab {
        isFullImage ? .develop : .info
    }

    /// Stable accessibility identifier for an `AdjustSlider` — lowercased,
    /// spaces collapsed to dashes. "NR Lum" → `slider-nr-lum`. See
    /// docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md.
    static func sliderAccessibilityID(for label: String) -> String {
        let slug = label
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
        return "slider-\(slug)"
    }
}
