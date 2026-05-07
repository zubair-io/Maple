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

  func update(model: AdjustmentModel, culling: CullingState)
  func flush() async
}

extension XMPSidecarStore: SidecarStoreProtocol {}
