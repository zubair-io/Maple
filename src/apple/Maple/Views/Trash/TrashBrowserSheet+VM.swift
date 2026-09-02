// TrashBrowserSheet+VM.swift — pure folder-grouping derivation for the
// in-app Trash browser's "Restore Folder" surface (#2751).
//
// Pattern (issue #192): a sibling +VM.swift holding the derivations,
// unit-testable in isolation. This file MUST NOT `import SwiftUI`.

import Foundation

enum TrashBrowserSheetVM {

    /// Rows grouped by the directory portion of `originalRelativePath` —
    /// what turns the flat trashed-asset list into the "browsable/
    /// actionable folder surface" #2751 asks for, with no new server
    /// endpoint needed: every row already carries its own original
    /// location.
    ///
    /// `id == ""` is the root group — items trashed directly at the
    /// library root, which have no folder to restore as a unit (there's
    /// nothing above them to name). `id` for every other group is the
    /// full relative directory path (e.g. `"2024/Paris"`, not just
    /// `"Paris"`) so two same-named subfolders under different parents
    /// (`"2023/Paris"` and `"2024/Paris"`) never collide or render with
    /// identical, ambiguous headers.
    struct RowGroup: Identifiable, Equatable {
        let id: String
        let rows: [TrashBrowserRow]

        var isRoot: Bool { id.isEmpty }
    }

    /// Root sorts first, subfolders alphabetically (case-insensitive)
    /// after it.
    static func groups(for rows: [TrashBrowserRow]) -> [RowGroup] {
        let grouped = Dictionary(grouping: rows) { row in
            (row.originalRelativePath as NSString).deletingLastPathComponent
        }
        let sortedKeys = grouped.keys.sorted { lhs, rhs in
            if lhs.isEmpty != rhs.isEmpty { return lhs.isEmpty }
            return lhs.localizedStandardCompare(rhs) == .orderedAscending
        }
        return sortedKeys.map { key in
            RowGroup(id: key, rows: grouped[key] ?? [])
        }
    }
}
