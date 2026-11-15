import Foundation

extension PanoMergeSession {
  /// Sendable error carrier for the run and preview states.
  public struct StitchError: Sendable {
    public let message: String

    public init(underlying: any Error) {
      self.message = underlying.localizedDescription
    }

    init(message: String) {
      self.message = message
    }
  }

  public enum RunState: Sendable {
    case idle
    /// Waiting for the preview's reusable alignment before stitching.
    case finishingAlignment
    case running(stage: PanoStage, stageFraction: Double, overallFraction: Double)
    case done(result: PanoResult)
    case error(StitchError)
  }

  public enum PreviewState: Sendable {
    case idle
    /// Waiting out the debounce after an option change.
    case scheduled
    case running(stage: PanoStage, overallFraction: Double)
    case ready
    case failed(StitchError)
  }
}
