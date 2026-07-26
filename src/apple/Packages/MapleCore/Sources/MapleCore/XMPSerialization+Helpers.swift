// XMPSerialization+Helpers.swift — private XMPSerializer formatting helpers.
// Split out of XMPSerialization.swift to stay under the 600-LOC hard budget
// (#1181). These are fileprivate within the module so XMPSerializer can call
// them from XMPSerialization.swift.

import Foundation

// MARK: - XMPSerializer formatting helpers

extension XMPSerializer {
    /// Format a crop edge or angle value. 6 significant decimal places —
    /// matches the reference renderer's output and keeps sidecars
    /// byte-interchangeable across platforms for the crop group. The one
    /// documented exception to `fmtNum` below: crop edges are normalized
    /// fractions where two decimals would quantize the rect to whole
    /// percents of the frame.
    static func fmtCrop(_ v: Double) -> String {
        String(format: "%.6f", v)
    }

    /// The canonical numeric wire codec (`docs/xmp-canonical-format.md`
    /// § "Number formatting"): integers emit without decimals, non-integers
    /// round to two decimals with trailing zeros trimmed. Byte-identical to
    /// the TS writer's `numericSerializer`, which is why #1577 routes every
    /// numeric attribute through it — the old per-field `%.0f` / `%.1f` /
    /// `%.2f` formats both diverged from the web writer and silently
    /// quantized fractional slider values on every re-save.
    static func fmtNum(_ v: Double) -> String {
        let rounded = (v * 100).rounded() / 100
        if rounded == rounded.rounded() {
            return String(format: "%.0f", rounded)
        }
        // %.2f then trim one trailing zero — NOT %g, whose default 6
        // significant digits silently truncates large fractional
        // temperatures (11500.25 → "11500.2"; PR #1900 review). The
        // integer branch above means the result never ends in ".00", so
        // at most one zero needs trimming and no bare trailing dot can
        // survive.
        let two = String(format: "%.2f", rounded)
        return two.hasSuffix("0") ? String(two.dropLast()) : two
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
