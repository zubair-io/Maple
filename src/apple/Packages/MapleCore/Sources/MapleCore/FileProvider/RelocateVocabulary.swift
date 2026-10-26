// RelocateVocabulary.swift — the relocate primitive's mode and collision
// vocabulary (#2631). Lives in MapleFileProviderCore because
// `RemoteCatalog`'s relocate calls speak it too; `RelocateTypes.swift` in
// MapleCore holds the rest of the primitive.

import Foundation

// MARK: - RelocateMode

public enum RelocateMode: Sendable, Equatable {
  /// Delete the source (primary + sidecar) once the copy is verified.
  case move
  /// Leave the source in place — the destination is a duplicate.
  case copy
}

// MARK: - CollisionPolicy

/// How to resolve a destination that's already occupied. Mirrors the design
/// doc: auto-suffix for unattended/background operations (migrations,
/// external-reconciliation), the other two for user-initiated operations
/// that have already resolved a Skip/Replace/Keep-Both prompt.
public enum CollisionPolicy: Sendable, Equatable {
  /// Append `.N` before the extension until free — never overwrites.
  /// Matches the API's `pickFreePath` (`src/api/src/fs/trash.ts`).
  case autoSuffix
  /// Fail with `FileOperationError.destinationExists` rather than touch
  /// an existing file. The right default for a user-facing operation that
  /// hasn't asked the user yet.
  case fail
  /// Overwrite the existing destination (primary + its sidecar, if any) —
  /// the user explicitly chose Replace. A destination sidecar another
  /// same-stem photo there still uses is never overwritten (#4707).
  case replace
}
