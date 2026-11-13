// EditorSeedStore.swift — the seed still for the open editor asset (#5755),
// written by the editor's seed loader outside the zoom host and read by the
// seed drawn inside its leaf.

import CoreGraphics
import Observation

@MainActor
@Observable
public final class EditorSeedStore {
  public private(set) var assetID: AssetRef.ID?
  public private(set) var image: CGImage?
  public private(set) var isDisplayPreview = false

  public init() {}

  public func image(for id: AssetRef.ID) -> CGImage? {
    assetID == id ? image : nil
  }

  public func hasDisplayPreview(for id: AssetRef.ID) -> Bool {
    assetID == id && isDisplayPreview
  }

  /// Drop the previous asset's seed before loading this one's, so its
  /// thumbnail never flashes over the new photo. Repeating it for the same
  /// asset keeps what is already loaded.
  public func begin(_ id: AssetRef.ID) {
    guard assetID != id else { return }
    assetID = id
    image = nil
    isDisplayPreview = false
  }

  /// A thumbnail arriving after the display preview does not replace it, and
  /// a load for an asset no longer open is dropped.
  public func publish(_ image: CGImage, for id: AssetRef.ID, isDisplayPreview: Bool) {
    guard assetID == id, isDisplayPreview || !self.isDisplayPreview else { return }
    self.image = image
    self.isDisplayPreview = isDisplayPreview
  }
}
