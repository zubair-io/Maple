// XMPSerialization+Helpers.swift — private XMPSerializer formatting helpers.
// Split out of XMPSerialization.swift to stay under the 600-LOC hard budget
// (#1181). These are fileprivate within the module so XMPSerializer can call
// them from XMPSerialization.swift.

import Foundation

// MARK: - XMPSerializer formatting helpers

extension XMPSerializer {
    /// Format an exposure value to two decimal places, matching the reference
    /// renderer's wire format.
    static func fmtF(_ v: Double) -> String {
        String(format: "%.2f", v)
    }

    /// Format a crop edge or angle value. 6 significant decimal places —
    /// matches the reference renderer's output and keeps sidecars
    /// byte-interchangeable across platforms for the crop group.
    static func fmtCrop(_ v: Double) -> String {
        String(format: "%.6f", v)
    }

    /// Format a WB slider value (`crs:Temperature` / `crs:Tint`),
    /// preserving fractional precision: integers emit without decimals
    /// (byte-stable with the historical `%.0f` output for the common
    /// case), non-integers round to 2 decimals with trailing zeros
    /// trimmed — mirroring the TS writer's `numericSerializer`. Needed
    /// since #1893's V2/V3 → V4 load-normalization scales authored tints
    /// by 0.3 (e.g. −144 → −43.2): integer rounding here would shift the
    /// stored WB on every re-save, drifting the rendered look.
    static func fmtWb(_ v: Double) -> String {
        let rounded = (v * 100).rounded() / 100
        return rounded == rounded.rounded()
            ? String(format: "%.0f", rounded)
            : String(format: "%g", rounded)
    }

    /// Minimal XML 1.0 text-content escaping — only `&`, `<`, `>` are
    /// strictly required between tags. `"` and `'` are attribute-only.
    static func escapeXMLText(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}

extension XMPParser {
    /// Parse a `papp:Hidden` attribute value. Only exact "true"/"false" are
    /// recognized (matching what `XMPSerializer` ever writes) — anything
    /// else returns nil so the caller leaves `hidden` at its current default
    /// (no override) instead of silently coercing to false.
    static func parseHiddenAttribute(_ value: String) -> Bool? {
        switch value.lowercased() {
        case "true": return true
        case "false": return false
        default: return nil
        }
    }
}
