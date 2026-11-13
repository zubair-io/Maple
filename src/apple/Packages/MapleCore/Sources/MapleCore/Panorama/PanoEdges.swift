// PanoEdges.swift — What the engine did with Boundary Warp and Auto Crop, and
// the words the merge sheet shows for it (#5575, epic #5570).

import Foundation

/// Outcome of the Boundary Warp step, as the engine reports it. Mirrors the
/// report JSON's `edges.boundary_warp.status` and `MaplePanoBoundaryWarpStatus`.
public enum PanoBoundaryWarpStatus: Sendable, Equatable, CaseIterable {
    case off
    case applied
    /// Applied, but weaker than requested so the image doesn't fold.
    case clampedFold
    case refusedFullWrap
    case refusedDisconnected
    case refusedEmpty
    case refusedShape
    case refusedSolve
    case refusedFold

    /// `nil` for a value this build does not know, so a newer engine's status
    /// shows the plain helper and no reason rather than failing.
    public init?(ffiValue: Int) {
        switch ffiValue {
        case 0: self = .off
        case 1: self = .applied
        case 2: self = .clampedFold
        case 3: self = .refusedFullWrap
        case 4: self = .refusedDisconnected
        case 5: self = .refusedEmpty
        case 6: self = .refusedShape
        case 7: self = .refusedFold
        case 8: self = .refusedSolve
        default: return nil
        }
    }
}

/// The rectangle Auto Crop found, in pixels of the image the engine wrote (the
/// whole canvas), which is `outputWidth` by `outputHeight`. The image is never
/// trimmed: the rectangle becomes the panorama's crop (#5608).
public struct PanoAutoCrop: Sendable, Equatable {
    public let outputWidth: Int
    public let outputHeight: Int
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int

    public init(outputWidth: Int, outputHeight: Int, x: Int, y: Int, width: Int, height: Int) {
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    /// The rectangle fits the image and is smaller than it.
    var cropsAnything: Bool {
        width > 0 && height > 0 && x >= 0 && y >= 0
            && x + width <= outputWidth && y + height <= outputHeight
            && (width < outputWidth || height < outputHeight)
    }

    /// The rectangle in the pixels of an image `scale` times this one's, such as
    /// the preview PNG against the full canvas.
    func rect(in imageWidth: Int, _ imageHeight: Int) -> CGRect {
        let sx = Double(imageWidth) / Double(outputWidth)
        let sy = Double(imageHeight) / Double(outputHeight)
        return CGRect(
            x: (Double(x) * sx).rounded(), y: (Double(y) * sy).rounded(),
            width: (Double(width) * sx).rounded(), height: (Double(height) * sy).rounded())
    }
}

/// What a preview or stitch did with the edge settings.
public struct PanoEdgesReport: Sendable, Equatable {
    public let boundaryWarpStatus: PanoBoundaryWarpStatus
    /// Strength actually applied, in percent. Fractional when clamped.
    public let boundaryWarpApplied: Double
    /// The rectangle Auto Crop found; `nil` when it was off or none fits.
    public let crop: PanoAutoCrop?

    public var autoCropped: Bool { crop != nil }

    public init(boundaryWarpStatus: PanoBoundaryWarpStatus, boundaryWarpApplied: Double, crop: PanoAutoCrop? = nil) {
        self.boundaryWarpStatus = boundaryWarpStatus
        self.boundaryWarpApplied = boundaryWarpApplied
        self.crop = crop
    }

    /// The sentence that explains why the warp is not at the requested
    /// strength; `nil` when it took effect in full, is off, or the status is
    /// one that needs no explanation. Shown under the slider as a warning.
    public var boundaryWarpReason: String? {
        switch boundaryWarpStatus {
        case .off, .applied:
            return nil
        case .clampedFold:
            return "Limited to \(Int(boundaryWarpApplied.rounded()))% so the image doesn't fold."
        case .refusedDisconnected:
            return "Not applied: the frames form separate pieces, so the edges stay as stitched."
        case .refusedFullWrap:
            return "Not applied to 360\u{00B0} panoramas. Auto Crop can still trim the top and bottom."
        case .refusedFold:
            return "Not applied: warping this shape would fold the image."
        case .refusedEmpty:
            return "Not applied: there are no stitched pixels to warp."
        case .refusedShape:
            return "Not applied: this panorama's outline can't be warped, so the edges stay as stitched."
        case .refusedSolve:
            return "Not applied: the warp couldn't be computed for this panorama, so the edges stay as stitched."
        }
    }

    public static let boundaryWarpHelp = "Stretches the edges toward a full rectangle."
    public static let autoCropHelp = "Crops to the largest rectangle with no empty edges."

    /// The line under the Boundary Warp slider. At 0% it is the plain help
    /// and never a reason; otherwise the latest report's reason replaces the
    /// help and stays until a newer report arrives. `isReason` selects the
    /// warning style.
    public static func boundaryWarpLine(
        requested: Double, report: PanoEdgesReport?
    ) -> (text: String, isReason: Bool) {
        guard requested > 0, let reason = report?.boundaryWarpReason else {
            return (boundaryWarpHelp, false)
        }
        return (reason, true)
    }
}
