// EditSession+SidecarErrors.swift — what the editor reports as a failed
// save. Cancelled work is not a failure and never reaches the banner (#5735).

import Foundation

/// A rating or flag was made before the photo's saved edits loaded, and
/// they still have not loaded, so the change could not be merged and saved.
public struct SidecarNotLoadedError: LocalizedError, Equatable {
  public init() {}

  public var errorDescription: String? {
    "The photo's saved edits haven't loaded yet, so this change wasn't saved. Try again."
  }
}

@MainActor
extension EditSession {
  /// Records a sidecar failure for the editor's banner. Cancellations are
  /// dropped: the work was abandoned, not refused.
  func recordSidecarError(_ error: Error) {
    guard !error.isCancellation else { return }
    sidecarError = error
  }

  /// The error for an edit that needed the sidecar loaded when the load
  /// did not complete: the real read failure if there was one.
  var sidecarNotLoadedError: Error {
    sidecarError ?? SidecarNotLoadedError()
  }
}
