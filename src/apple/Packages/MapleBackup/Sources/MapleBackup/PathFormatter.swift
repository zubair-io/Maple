//
// PathFormatter.swift
//
// Mirrors `src/api/src/backup/path-formatter.ts::formatBackupPath`
// (a parity pair — identical inputs must produce byte-identical output).
//
// Layout:
//   With location:    <year>/<seg1>/<seg2>/…/<filename>
//   Without location: <year>/<MM>/<filename>
//
// `location` is an ordered list of geographic directory segments derived from
// the reverse-geocoded place:
//   - USA:       ["<State>", "<Town/City || Place Name>"]   e.g. ["California", "San Francisco"]
//   - elsewhere: ["<Country>", "<Town/City || Place Name>"] e.g. ["France", "Paris"]
// Each segment is sanitised independently: trimmed, `/` and `\` replaced with
// `_` (so one segment can't add a directory level), and dropped if empty or a
// path-traversal token (`.`, `..`, or a leading dot). When no usable segment
// survives, the path falls back to the date-only `<year>/<MM>` layout.
//
// Filename is validated: rejects empty, `.`, `..`, leading dot, any `/` or
// `\`, and >255 chars. Throws PathFormatterError.unsafeFilename otherwise.
//
// On device the real upload path is computed server-side (the phone has no
// reverse geocoder); this mirror exists for the settings preview and the
// cross-language parity test.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §9;
// docs/superpowers/specs/2026-06-05-backup-geo-layout.md.

import Foundation

public enum PathFormatterError: Error, Equatable {
    case unsafeFilename(String)
}

public enum PathFormatter {

    /// Reject filenames that could escape the library root. Mirrors
    /// `isSafeFilename` on the server.
    public static func isSafeFilename(_ name: String) -> Bool {
        if name.isEmpty || name.count > 255 { return false }
        if name.contains("/") || name.contains("\\") { return false }
        if name == "." || name == ".." { return false }
        if name.hasPrefix(".") { return false }
        return true
    }

    /// Sanitise an ordered list of location segments into safe, single-level
    /// directory names. Mirrors `sanitizeLocationSegments` on the server: per
    /// segment trim, drop empties, replace `/` and `\` with `_`, and drop
    /// path-traversal tokens (`.`, `..`, leading dot). Surviving segments keep
    /// their order.
    private static func sanitizeLocationSegments(_ location: [String]?) -> [String] {
        guard let location else { return [] }
        var out: [String] = []
        for raw in location {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            let escaped = trimmed
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "\\", with: "_")
            if escaped == "." || escaped == ".." || escaped.hasPrefix(".") { continue }
            out.append(escaped)
        }
        return out
    }

    public static func format(captureDate: Date,
                              location: [String]?,
                              filename: String) throws -> String {
        guard isSafeFilename(filename) else {
            throw PathFormatterError.unsafeFilename(filename)
        }

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = cal.dateComponents([.year, .month], from: captureDate)
        let y = String(format: "%04d", comps.year ?? 0)
        let m = String(format: "%02d", comps.month ?? 0)

        let segs = sanitizeLocationSegments(location)
        if !segs.isEmpty {
            return "\(y)/\(segs.joined(separator: "/"))/\(filename)"
        }
        return "\(y)/\(m)/\(filename)"
    }
}
