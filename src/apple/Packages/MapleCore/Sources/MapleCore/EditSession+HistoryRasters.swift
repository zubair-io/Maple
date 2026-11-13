// EditSession+HistoryRasters.swift — registry ownership of the bitmap mask
// rasters only the undo history still needs (#5122).
//
// A brush raster leaving the live model is released at once and stamped
// again from its dabs when a snapshot brings the layer back. A bitmap
// (person/skin) raster cannot be rebuilt in step with an undo, so when a
// commit, Undo or Redo drops one from the live model the transaction ring
// takes its registry entry. The ring releases it as soon as no undo, redo or
// open snapshot references it (a trim, or a new edit dropping the redo
// stack), and releases whatever it still holds when the ring itself goes:
// a closed session, or a history reset by hydration or a variant switch.

import Foundation

/// Bitmap raster ids that left the live model while a snapshot could still
/// restore them. Owned by `EditTransactionRing`.
final class HistoryRasters {
  private var ids: Set<UInt32> = []
  private let release: (UInt32) -> Void

  init(release: @escaping (UInt32) -> Void = { MaskRasterRegistry.release($0) }) {
    self.release = release
  }

  deinit {
    ids.forEach(release)
  }

  /// Takes `dropped`, hands back to the models any id in `owned`, then
  /// releases every remaining id `restorable` does not reference.
  func settle(dropped: Set<UInt32>, owned: Set<UInt32>, restorable: () -> Set<UInt32>) {
    ids.formUnion(dropped)
    ids.subtract(owned)
    guard !ids.isEmpty else { return }
    let unreachable = ids.subtracting(restorable())
    ids.subtract(unreachable)
    unreachable.forEach(release)
  }
}

extension EditSession {
  /// Call after the live model or the history changed. `outgoing` is the
  /// live model a transition replaced; its bitmap rasters the live and
  /// loaded models no longer hold pass to the history. Rasters in
  /// `originalModel` stay with the loaded state, which Reset restores.
  func settleHistoryRasters(leaving outgoing: AdjustmentModel? = nil) {
    let owned = Self.bitmapRasterIds(in: model).union(Self.bitmapRasterIds(in: originalModel))
    let dropped = outgoing.map { Self.bitmapRasterIds(in: $0).subtracting(owned) } ?? []
    transactions.rasters.settle(dropped: dropped, owned: owned) {
      var restorable = transactions.pending.map { Self.bitmapRasterIds(in: $0.before) } ?? []
      for tx in transactions.undoStack + transactions.redoStack {
        restorable.formUnion(Self.bitmapRasterIds(in: tx.before))
        restorable.formUnion(Self.bitmapRasterIds(in: tx.after))
      }
      return restorable
    }
  }

  static func bitmapRasterIds(in model: AdjustmentModel) -> Set<UInt32> {
    Set(model.localAdjustments.flatMap(\.mask.bitmapMasks).map(\.rasterId)).subtracting([0])
  }
}
