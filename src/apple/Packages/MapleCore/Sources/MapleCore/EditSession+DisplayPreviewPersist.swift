// EditSession+DisplayPreviewPersist.swift — persist the developed display
// preview on an idle debounce + on exit, never per slider tick (#2009).
//
// Policy (ticket #2009 §3): render-to-screen stays per-tick, but the canonical
// `<filename>.avif` preview is only WRITTEN when the user pauses (idle
// debounce) or leaves (close image / leave full-image / background). A slider
// drag settles into many 150 ms refine renders; encoding + writing a 1280 px
// AVIF on every one is wasted I/O the reader never benefits from — only the
// final state matters. The exit flush guarantees the last state always lands.
//
// The render-publish paths call `scheduleDisplayPreviewPersist(_:)` with the
// latest full-canvas frame; the app calls `persistDisplayPreviewOnExit()` when
// the editor tears down. Destination (local file vs. cloud `PUT`) is the
// session's `previewPersistence`; the encode + write run off the MainActor.

import CoreImage
import Foundation

@MainActor
extension EditSession {
  func scheduleDisplayPreviewPersist(_ rendered: CIImage) {
    previewPersistence.schedule(rendered)
  }

  func flushDisplayPreviewPersist(expectedModel: AdjustmentModel? = nil) async {
    guard await cancelAndJoinDisplayPreviewPersist(expectedModel: expectedModel) else { return }
    let capturedModel = model
    await previewPersistence.persistPending { self.model == capturedModel }
  }

  @discardableResult
  func cancelAndJoinDisplayPreviewPersist(expectedModel: AdjustmentModel? = nil) async -> Bool {
    if let expectedModel, model != expectedModel { return false }
    await previewPersistence.cancelAndJoin()
    if let expectedModel, model != expectedModel { return false }
    return true
  }

  /// Editor-exit entry point (close image / leave full-image / background).
  /// Handles both render paths:
  ///   • CPU path — every refine already captured a frame into
  ///     the persistence owner, so flushing persists the last one.
  ///   • GPU-live path — no CIImage is ever published (it presents straight
  ///     to the `CAMetalLayer`), so read the current frame back once and
  ///     persist that; this also refreshes the browse thumbnail (#1879).
  /// Whichever path ran, the other's branch is a cheap no-op.
  ///
  /// `async` + strong `self`: the caller (`Task { await session.persist… }`,
  /// with the app kept awake on iOS background) holds the session alive until
  /// the write lands. A fire-and-forget `Task { [weak self] … }` here would
  /// drop the final write if the session deallocated on teardown (jules
  /// review, #2009).
  public func persistDisplayPreviewOnExit() async {
    let exitModel = model
    // Cache variants use the sidecar mtime: commit the final transaction
    // before capturing pixels and their cache revision.
    await flushPendingSidecarWrite()
    guard model == exitModel else { return }
    // Cancellation alone cannot stop an encode/write already in progress.
    // Drain it before the current GPU frame can become the final sink write.
    guard await cancelAndJoinDisplayPreviewPersist(expectedModel: exitModel) else { return }
    await refreshThumbnailFromCurrentGpuFrame(expectedModel: exitModel)
    guard model == exitModel else { return }
    await flushDisplayPreviewPersist(expectedModel: exitModel)
  }

}
