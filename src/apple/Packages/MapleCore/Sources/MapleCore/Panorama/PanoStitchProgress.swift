// PanoStitchProgress.swift — what the merge sheet pins inside its preview while
// the full stitch runs, and how tall that preview may be.

import CoreGraphics
import Foundation

/// The stitch's stage and overall progress, shown inside the pinned preview so
/// it stays in view while the options scroll.
public struct PanoStitchProgress: Equatable, Sendable {
    /// The share of the bar the alignment phase takes when a stitch has one,
    /// so the bar never falls back when the composite starts.
    public static let alignmentShare = 0.3

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
            let alignment: Double
            if let freshAlignmentFraction {
                alignment = freshAlignmentFraction
            } else if case .running(_, let overall) = previewState {
                alignment = overall
            } else {
                alignment = 1
            }
            return PanoStitchProgress(
                title: "Finishing alignment…", fraction: alignment * PanoStitchProgress.alignmentShare)
        case .running(let stage, _, let overall):
            let fraction = stitchIncludesAlignment
                ? PanoStitchProgress.alignmentShare + overall * (1 - PanoStitchProgress.alignmentShare)
                : overall
            return PanoStitchProgress(
                title: runsOnServer && overall == 0 ? "Waiting for the server…" : stage.displayName,
                fraction: fraction)
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
