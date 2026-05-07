// SidecarStoreProtocol.swift
//
// Surface that EditSession needs from a sidecar store. XMPSidecarStore
// (local files) and CloudSidecarStore (remote API) both conform.

import Foundation

public protocol SidecarStoreProtocol: Actor {
  func load() async throws -> (AdjustmentModel, CullingState)
  func update(model: AdjustmentModel, culling: CullingState)
  func flush() async
}

extension XMPSidecarStore: SidecarStoreProtocol {}
