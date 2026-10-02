// SidecarStoreProtocol.swift
//
// Surface that EditSession needs from a sidecar store. XMPSidecarStore
// (local files) and CloudSidecarStore (remote API) both conform.

import Foundation

public protocol SidecarStoreProtocol: Actor {
  /// Returns the persisted adjustments, or `(.default, CullingState())`
  /// if no sidecar exists yet. Always non-nil.
  func load() async throws -> (AdjustmentModel, CullingState)

  /// Returns the persisted adjustments only if a sidecar actually exists,
  /// else `nil`. Used by `EditSession` to decide whether to seed from
  /// as-shot WB (fresh image) or honor the user's stored edits.
  ///
  /// Local impl: checks file existence on disk.
  /// Cloud impl: distinguishes a real 200 response from a 404.
  func loadIfPresent() async throws -> (AdjustmentModel, CullingState)?

  func update(model: AdjustmentModel, culling: CullingState) async
  func flush() async

  /// Cancel pending debounce and durably write this exact snapshot. Batch
  /// operations count success only after this throwing boundary returns.
  func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws

  /// Returns an async stream of errors encountered during background writes.
  func errors() async -> AsyncStream<Error>
}

/// Concrete capability of stores whose actual editor boundary persists
/// portable semantic history. SMB hosts follow under #2437 (#4056).
public protocol SemanticSidecarStoreProtocol: SidecarStoreProtocol {
  func commitSemantic(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) async throws
}

extension XMPSidecarStore: SemanticSidecarStoreProtocol {}
