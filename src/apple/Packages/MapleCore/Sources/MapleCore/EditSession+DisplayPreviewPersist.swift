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
// session's `previewSink`; the encode + write run off the MainActor.

import CoreImage
import Foundation

@MainActor
extension EditSession {
  /// Idle-debounce window before a captured frame is persisted. Longer than
  /// the 150 ms refine debounce and the 750 ms sidecar autosave so a
  /// continuous edit coalesces to a single write after the user pauses.
  static let displayPreviewIdleDebounce: Duration = .milliseconds(1_500)

  /// Capture the latest full-canvas render for eventual persist and (re)arm
  /// the idle-debounce timer. No-op when the session has no preview
  /// destination (sourceless assets). Each call cancels the prior pending
  /// write, so only the frame the user settled on is encoded.
  func scheduleDisplayPreviewPersist(_ rendered: CIImage) {
    guard previewSink != nil else { return }
    pendingPreviewImage = rendered
    previewPersistTask?.cancel()
    previewPersistTask = Task { [weak self] in
      try? await Task.sleep(for: Self.displayPreviewIdleDebounce)
      guard !Task.isCancelled else { return }
      await self?.persistPendingDisplayPreview()
    }
  }

  /// Flush any pending preview immediately — cancels the debounce and writes
  /// now. Call on editor exit so leaving before the idle window still
  /// persists the final edit.
  func flushDisplayPreviewPersist(expectedModel: AdjustmentModel? = nil) async {
    guard await cancelAndJoinDisplayPreviewPersist(expectedModel: expectedModel) else { return }
    await persistPendingDisplayPreview()
  }

  @discardableResult
  func cancelAndJoinDisplayPreviewPersist(expectedModel: AdjustmentModel? = nil) async -> Bool {
    if let expectedModel, model != expectedModel { return false }
    let pending = previewPersistTask
    previewPersistTask = nil
    pending?.cancel()
    await pending?.value
    if let expectedModel, model != expectedModel { return false }
    return true
  }

  /// Editor-exit entry point (close image / leave full-image / background).
  /// Handles both render paths:
  ///   • CPU path — every refine already captured a frame into
  ///     `pendingPreviewImage`, so flushing persists the last one.
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

  /// Encode the pending frame off the MainActor and hand the bytes to the
  /// sink. Clears `pendingPreviewImage` up front so a concurrent flush +
  /// debounce can't double-encode the same frame.
  private func persistPendingDisplayPreview() async {
    guard let sink = previewSink, let image = pendingPreviewImage else { return }
    pendingPreviewImage = nil
    let data = await Task.detached(priority: .utility) {
      ThumbnailLoader.encodeDisplayPreview(from: image)
    }.value
    guard let data else { return }
    await sink.write(data)
  }
}
