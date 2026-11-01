// PanoPreview.swift — Quick-preview result and the reusable solved alignment (#4579).

import CoreGraphics
import Foundation

/// The solved alignment maple-pano writes beside a preview, held in memory
/// for the lifetime of a merge session and handed to the full stitch.
public struct PanoAlignment: Sendable, Equatable {
    public let json: Data
    /// A server preview's alignment stays on the server; the stitch names the
    /// preview job instead (#5488).
    public let serverPreviewJobID: String?

    public init(json: Data, serverPreviewJobID: String? = nil) {
        self.json = json
        self.serverPreviewJobID = serverPreviewJobID
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
    /// What the engine did with the edge settings this preview was built
    /// with; `nil` when the stitcher does not report it.
    public let edges: PanoEdgesReport?

    public init(
        image: CGImage,
        alignment: PanoAlignment,
        alignmentOutcome: PanoAlignmentOutcome,
        stitchSizes: PanoStitchSizes? = nil,
        matcher: PanoMatcherOutcome = .used(.classical),
        edges: PanoEdgesReport? = nil
    ) {
        self.image = image
        self.alignment = alignment
        self.alignmentOutcome = alignmentOutcome
        self.stitchSizes = stitchSizes
        self.matcher = matcher
        self.edges = edges
    }

    /// The preview as the panorama will show: framed to the Auto Crop rectangle
    /// when `autoCrop` is on and the engine found one, the whole canvas otherwise.
    public func displayImage(autoCrop: Bool) -> CGImage {
        guard autoCrop, let crop = edges?.crop, crop.cropsAnything,
            let framed = image.cropping(to: crop.rect(in: image.width, image.height))
        else { return image }
        return framed
    }

    func with(matcher: PanoMatcherOutcome) -> PanoPreview {
        PanoPreview(
            image: image,
            alignment: alignment,
            alignmentOutcome: alignmentOutcome,
            stitchSizes: stitchSizes,
            matcher: matcher,
            edges: edges
        )
    }
}
