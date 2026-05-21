//
// PathFormatter.swift
//
// Mirrors `src/api/src/backup/path-formatter.ts::formatBackupPath`.
// Task 2.10 adds a JSON-driven parity test that runs identical cases
// through both implementations and asserts byte-identical output.
//
// Layout:
//   With location:    <year>/<location>/<MM>-<DD>/<filename>
//   Without location: <year>/<MM>/<DD>/<filename>
//
// `/` in the location is replaced with `_` to keep the result a single
// directory level. An empty / whitespace-only / `..` / leading-dot location
// is treated as nil (path-traversal guard).
//
// Filename is validated: rejects empty, `.`, `..`, leading dot, any `/` or
// `\`, and >255 chars. Throws PathFormatterError.unsafeFilename otherwise.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §9.

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

    /// Returns `nil` for any location that is unsafe to use as a directory
    /// component. The caller treats `nil` as "no location" and falls back
    /// to the year/MM/DD shape.
    private static func sanitizedLocation(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty || trimmed == "." || trimmed == ".." { return nil }
        if trimmed.hasPrefix(".") { return nil }
        let escaped = trimmed.replacingOccurrences(of: "/", with: "_")
        return escaped
    }

    public static func format(captureDate: Date,
                              location: String?,
                              filename: String) throws -> String {
        guard isSafeFilename(filename) else {
            throw PathFormatterError.unsafeFilename(filename)
        }

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = cal.dateComponents([.year, .month, .day], from: captureDate)
        let y = String(format: "%04d", comps.year ?? 0)
        let m = String(format: "%02d", comps.month ?? 0)
        let d = String(format: "%02d", comps.day ?? 0)

        if let loc = sanitizedLocation(location) {
            return "\(y)/\(loc)/\(m)-\(d)/\(filename)"
        }
        return "\(y)/\(m)/\(d)/\(filename)"
    }
}
