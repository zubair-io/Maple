// PanoPreview.swift — Quick-preview result and the reusable solved alignment (#4579).

import CoreGraphics
import Foundation

/// The solved alignment maple-pano writes beside a preview, held in memory
/// for the lifetime of a merge session and handed to the full stitch.
public struct PanoAlignment: Sendable, Equatable {
    public let json: Data

    public init(json: Data) {
        self.json = json
    }
}

/// What happened to an offered alignment.
public enum PanoAlignmentOutcome: Sendable, Equatable {
    /// No alignment was offered; matching ran.
    case solved
    /// The offered alignment matched; matching was skipped.
    case reused
    /// The offered alignment no longer matched the inputs or geometry
    /// options, so matching re-ran.
    case stale(reason: String)

    public var summary: String {
        switch self {
        case .solved: return "Alignment solved."
        case .reused: return "Alignment reused from the preview; matching skipped."
        case .stale(let reason): return "Preview alignment was stale (\(reason)); matching re-ran."
        }
    }
}

/// A display-encoded low-resolution panorama plus its solved alignment.
public struct PanoPreview: @unchecked Sendable {
    /// Immutable decoded preview; `@unchecked` because `CGImage` is
    /// immutable but not annotated `Sendable` on every SDK this package
    /// supports.
    public let image: CGImage
    public let alignment: PanoAlignment
    public let alignmentOutcome: PanoAlignmentOutcome
    /// What the full stitch of these frames will hold; `nil` when the
    /// stitcher cannot say (the mock).
    public let stitchSizes: PanoStitchSizes?
    public let matcher: PanoMatcherOutcome

    public init(
        image: CGImage,
        alignment: PanoAlignment,
        alignmentOutcome: PanoAlignmentOutcome,
        stitchSizes: PanoStitchSizes? = nil,
        matcher: PanoMatcherOutcome = .used(.classical)
    ) {
        self.image = image
        self.alignment = alignment
        self.alignmentOutcome = alignmentOutcome
        self.stitchSizes = stitchSizes
        self.matcher = matcher
    }

    func with(matcher: PanoMatcherOutcome) -> PanoPreview {
        PanoPreview(
            image: image,
            alignment: alignment,
            alignmentOutcome: alignmentOutcome,
            stitchSizes: stitchSizes,
            matcher: matcher
        )
    }
}
