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

    /// Minimal XML 1.0 text-content escaping — only `&`, `<`, `>` are
    /// strictly required between tags. `"` and `'` are attribute-only.
    static func escapeXMLText(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}
