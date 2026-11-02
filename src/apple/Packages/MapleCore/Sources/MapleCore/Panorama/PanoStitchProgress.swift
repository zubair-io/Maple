// PanoStitchProgress.swift — what the merge sheet pins inside its preview while
// the full stitch runs, and how tall that preview may be.

import CoreGraphics
import Foundation

/// The stitch's stage and overall progress, shown inside the pinned preview so
/// it stays in view while the options scroll.
public struct PanoStitchProgress: Equatable, Sendable {
    public let title: String
    public let fraction: Double

    public init(title: String, fraction: Double) {
        self.title = title
        self.fraction = fraction
    }
}

extension PanoMergeSession {
    /// `nil` unless the full stitch is waiting for its alignment or running.
    public func stitchProgress(runsOnServer: Bool) -> PanoStitchProgress? {
        switch state {
        case .finishingAlignment:
            let preview: Double
            if case .running(_, let overall) = previewState { preview = overall } else { preview = 1 }
            return PanoStitchProgress(title: "Finishing alignment…", fraction: preview)
        case .running(let stage, _, let overall):
            return PanoStitchProgress(
                title: runsOnServer && overall == 0 ? "Waiting for the server…" : stage.displayName,
                fraction: overall)
        case .idle, .done, .error:
            return nil
        }
    }
}

public enum PanoPreviewLayout {
    /// The preview image may take this share of the sheet's height, so a tall
    /// panorama never covers the options.
    public static let heightShare: CGFloat = 0.35

    /// Used until the sheet has been measured.
    public static let unmeasuredHeight: CGFloat = 220

    public static func maxImageHeight(sheetHeight: CGFloat) -> CGFloat {
        sheetHeight > 0 ? (sheetHeight * heightShare).rounded(.down) : unmeasuredHeight
    }
}
