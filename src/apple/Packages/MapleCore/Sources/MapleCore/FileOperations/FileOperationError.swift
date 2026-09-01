// FileOperationError.swift — typed errors for the local file-operations
// module (relocate / trash / folder CRUD), issue #2631.
//
// Every case is a distinct, UI-explainable failure — never a generic
// "something went wrong." `.unsupportedSource` in particular is the surface
// a caller uses to explain why file-management actions are unavailable for a
// PhotoKit-backed asset (no user-writable path, see
// docs/spec/01-data-model.md invariant #3) or a Cloud-backed one (routes
// through the Self Hosted API instead of this on-device module — see the
// design doc's "Platform routing" table). This module itself only implements
// Filesystem and SMB; a caller that dispatches by source kind throws this
// case directly rather than letting an unsupported source fall through to a
// misleading filesystem error.

import Foundation

public enum FileOperationError: Error, LocalizedError, Equatable {
    /// The source has no on-device, user-writable file path this module can
    /// operate on (PhotoKit), or the operation is routed elsewhere entirely
    /// (Cloud sources go through the Self Hosted API, not this module).
    case unsupportedSource(String)

    /// The primary file (or the folder) was gone by the time we tried to
    /// read it — vanished between the caller's snapshot and this call.
    case sourceMissing(String)

    /// A copy completed but its destination didn't match the source
    /// (size/mtime mismatch). The partial copy is removed before this
    /// throws; the source is always left untouched.
    case verificationFailed(String)

    /// `CollisionPolicy.fail` was requested and the destination already
    /// existed.
    case destinationExists(String)

    /// The destination is invalid for this operation — outside the
    /// library root, or (for a folder move) inside the folder's own
    /// subtree.
    case invalidDestination(String)

    /// A single filename/foldername component failed
    /// `FilenameValidation.isValidPathComponent` — contains a path separator
    /// (which would smuggle a `../` traversal past `appendingPathComponent`,
    /// #2645 review), is empty, `.`/`..`, a trailing dot/space, or a
    /// Windows-reserved device name (enforced on every platform — see
    /// `raw_core::filename::validate_filename`'s doc comment for why).
    case invalidName(String)

    /// The destination names the SAME on-disk file as the source — directly,
    /// or through a symlinked ancestor directory. Refused before any
    /// remove/copy runs: without this guard, `.replace`'s pre-copy removal
    /// (or a same-path no-op) could delete the only copy of the file. Does
    /// NOT fire for a case-only rename on a case-insensitive-but-case-
    /// preserving filesystem (APFS/SMB default) — that's a legitimate
    /// rename, handled as a direct atomic move instead. See
    /// `LocalFileOperations.classifySameFile`.
    case sameFile(String)

    /// A lower-level `FileManager`/SMB error, wrapped with context. Kept as
    /// a `String` (not the original `Error`) so this type can stay
    /// `Equatable` for tests.
    case underlying(String)

    /// An OS file/folder drop (#2649) had no supported RAW/image/video/
    /// audio extension among the dropped files, and no folder was dropped
    /// either. Surfaced in `browseVM.loadError`'s banner so the refusal is
    /// explained rather than silent.
    case unsupportedDropType([String])

    public var errorDescription: String? {
        switch self {
        case .unsupportedSource(let s):
            return "Not supported for this source: \(s)"
        case .sourceMissing(let s):
            return "File no longer exists: \(s)"
        case .verificationFailed(let s):
            return "Copy verification failed: \(s)"
        case .destinationExists(let s):
            return "Destination already exists: \(s)"
        case .invalidDestination(let s):
            return "Invalid destination: \(s)"
        case .invalidName(let s):
            return "Invalid name: \(s)"
        case .sameFile(let s):
            return "Source and destination are the same file: \(s)"
        case .underlying(let s):
            return s
        case .unsupportedDropType(let extensions):
            let described = extensions.isEmpty
                ? "no supported file type"
                : extensions.joined(separator: ", ")
            return "Unsupported file type: Maple can't open \(described). Drop a RAW, image, video, or audio file, or a folder."
        }
    }
}

extension FileOperationError {
    /// PhotoKit assets have no user-writable path (`docs/spec/01-data-model.md`
    /// invariant #3) — every file-management action is unavailable for them,
    /// not just some. Callers building a source-aware dispatcher throw this
    /// directly for a PhotoKit-backed asset instead of attempting (and
    /// failing) a filesystem operation on a synthetic identifier.
    public static func photoKitUnsupported(operation: String) -> FileOperationError {
        .unsupportedSource(
            "PhotoKit: \(operation) is not supported — PhotoKit assets have no user-writable file path"
        )
    }

    /// Cloud (Self Hosted) sources route file operations through the API,
    /// not this on-device module — see the design doc's "Platform routing"
    /// table. A caller that reaches this module with a Cloud asset has
    /// mis-routed; this makes that mistake loud rather than attempting a
    /// meaningless local filesystem operation.
    public static func cloudRoutesThroughAPI(operation: String) -> FileOperationError {
        .unsupportedSource(
            "Cloud: \(operation) must go through the Self Hosted API, not the local file-operations module"
        )
    }
}
