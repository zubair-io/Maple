// FilenameValidation.swift — folder/file-name validation shared with every
// platform (#2645 review follow-up).
//
// A folder name typed into the source-tree context menu's New Folder /
// Rename prompt was previously accepted whenever it was non-empty, and
// `LocalFileOperations.createFolder`/`renameFolder` built the target via
// `parentDir.appendingPathComponent(name)` — `appendingPathComponent` SPLITS
// on an embedded `/`, so a name like `../../Desktop/oops` created
// directories outside the folder the UI named, bounded only by the
// security-scoped bookmark's OS-level reach. This wraps the canonical
// `raw_core::filename::validate_filename` rule set (already exposed via
// `maple_validate_filename` for the batch-rename engine, #2628) so a
// manually-typed folder name gets IDENTICAL rejection behaviour on every
// platform — the same reason the batch-rename engine enforces Windows'
// strictest rules everywhere: a folder is typically created once and may
// later be opened, renamed, or synced from any OS.
//
// Rules enforced (see `raw_core::filename::validate_filename`): non-empty,
// no path separator (`/` or `\` — this alone refuses `../x` and `a/b`), no
// leading dot (refuses both `.` and `..`, and anything meant to be hidden),
// no trailing dot or space, not an OS-reserved device name (`CON`, `PRN`,
// `COM1`, …).

import Foundation
import RawPipeline

public enum FilenameValidation {
    /// `true` when `name` is safe to use as a single filesystem path
    /// component (a folder or file's own name — not a multi-segment path).
    public static func isValidFolderName(_ name: String) -> Bool {
        name.withCString { maple_validate_filename($0) == 0 }
    }

    /// Shared copy for every New Folder / Rename prompt (local, SMB, Cloud)
    /// across the source-tree context menu (#2645 review) — one message so
    /// the rule set reads as one system regardless of which row the user
    /// right-clicked.
    public static let invalidNameMessage =
        "Names can't contain \"/\", start or end with a dot or space, or be a reserved device name (like CON or COM1)."
}
