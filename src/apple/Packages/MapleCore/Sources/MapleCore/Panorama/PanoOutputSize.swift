// PanoOutputSize.swift — Will the full stitch fit in this device's memory,
// and how small does the output have to be if not (#5454, #5555).
//
// The preview reports what the full stitch will hold (`PanoStitchSizes`).
// `PanoMemoryModel` turns that into a peak-memory estimate and, when the
// estimate exceeds the memory the OS will still grant this process, the
// largest output canvas that fits. Only the composite's share shrinks with
// the canvas: decode, matching and refinement work on full-resolution frames
// whatever the output size, so some sets cannot fit at any size. The disk
// side of the same question is `PanoDiskModel`.

import Foundation

#if os(iOS) || os(tvOS) || os(visionOS)
import os
#endif

// MARK: - PanoStitchSizes

/// What a full stitch of the previewed frames will hold, reported by the
/// preview.
public struct PanoStitchSizes: Sendable, Equatable {
    /// Full-resolution output canvas under the default canvas cap.
    public let canvasWidth: Int
    public let canvasHeight: Int
    /// Pixel count of the largest input frame at full resolution.
    public let largestFramePixels: Int
    public let frameCount: Int
    /// Temp-volume space the stitch's decoded-frame store needs, whatever
    /// the output size.
    public let scratchBytes: Int

    public init(canvasWidth: Int, canvasHeight: Int, largestFramePixels: Int, frameCount: Int, scratchBytes: Int) {
        self.canvasWidth = canvasWidth
        self.canvasHeight = canvasHeight
        self.largestFramePixels = largestFramePixels
        self.frameCount = frameCount
        self.scratchBytes = scratchBytes
    }

    /// Below this long edge the output is no larger than the preview
    /// already shown.
    public static let smallestUsefulLongEdge = 2048

    /// The largest canvas of at most `pixels` at this canvas's aspect, or
    /// `nil` when its long edge would be no larger than the preview.
    func fittedCanvas(maxPixels pixels: Int) -> PanoFittedCanvas? {
        guard pixels > 0 else { return nil }
        let scale = (Double(pixels) / Double(canvasWidth * canvasHeight)).squareRoot()
        return useful(width: Int((Double(canvasWidth) * scale).rounded(.down)), scale: scale)
    }

    /// The canvas `width` wide at this canvas's aspect, or `nil` when its
    /// long edge would be no larger than the preview.
    func fittedCanvas(width: Int) -> PanoFittedCanvas? {
        useful(width: width, scale: Double(width) / Double(canvasWidth))
    }

    var smallestUsefulCanvasPixels: Int {
        let scale = Double(Self.smallestUsefulLongEdge) / Double(max(canvasWidth, canvasHeight))
        return Int((Double(canvasWidth) * scale).rounded(.up)) * Int((Double(canvasHeight) * scale).rounded(.up))
    }

    private func useful(width: Int, scale: Double) -> PanoFittedCanvas? {
        let height = Int((Double(canvasHeight) * scale).rounded(.down))
        return max(width, height) >= Self.smallestUsefulLongEdge ? PanoFittedCanvas(width: width, height: height) : nil
    }
}

// MARK: - PanoFittedCanvas

/// A smaller output canvas, at the full canvas's aspect, that fits.
public struct PanoFittedCanvas: Sendable, Equatable {
    public let width: Int
    public let height: Int
    public var pixels: Int { width * height }
}

// MARK: - PanoOutputSize

/// The user's output-size choice in the merge sheet.
public enum PanoOutputSize: String, Sendable, CaseIterable {
    case full
    /// The largest canvas that fits this device's memory and storage.
    case fitted
}

// MARK: - PanoMemoryFit

public enum PanoMemoryFit: Sendable, Equatable {
    /// Full resolution fits.
    case fullFits(estimatedBytes: Int)
    /// Full resolution does not fit; this canvas, at the same aspect, does.
    case fitted(estimatedFullBytes: Int, canvas: PanoFittedCanvas)
    /// Not even a preview-sized canvas fits: the frames alone exceed it.
    case tooLarge(estimatedFullBytes: Int)
}

// MARK: - PanoMemoryModel

/// Memory a full stitch adds on top of the app's footprint when it starts:
/// the larger of
///
/// - the head — decode, matching and refinement, which work on
///   full-resolution frames whatever the output size: a per-frame term
///   (features, matches, per-frame solve state) plus one for the largest
///   frame (the banded decode and refinement windows);
/// - the composite — the per-frame state still held, a smaller term for the
///   largest frame (its source taps), and a term proportional to canvas
///   *width*: the composite streams fixed-height strips whose buffers are
///   output rows.
///
/// Calibrated after banded decode and refinement and tap-only composite
/// reads (#5552–#5566): pano_00 (3 × 100.7 MP, tile, 12315 px wide) on an
/// iPad adds 1263 MiB in the head and 593 MiB in the composite;
/// `maple-cli` on a Mac measures pano_00's composite at up to 1.2 GiB and
/// pano_01 (21 × 20.8 MP, rotation, 26981 px wide) at up to 1.8 GiB for the
/// head and 2.8 GiB for the composite. The constants are fitted to those
/// five figures and round up, so each overstates its measurement; the
/// Mac's allocator keeps more than the iPad's, so the column term is the
/// Mac's. Every input frame counts toward `frameCount`, dropped or not.
public struct PanoMemoryModel: Sendable, Equatable {
    public static let bytesPerFrame = 80 << 20
    public static let headBytesPerLargestFramePixel = 12
    public static let compositeBytesPerLargestFramePixel = 5
    public static let compositeBytesPerCanvasColumn = 49_350
    /// Headroom for what the model does not see (allocator fragmentation,
    /// the app itself, thumbnail work running alongside).
    public static let safetyFactor = 1.15

    public init() {}

    public func estimatedPeakBytes(sizes: PanoStitchSizes, canvasWidth: Int) -> Int {
        max(headBytes(sizes), compositeBytes(sizes, canvasWidth: canvasWidth))
    }

    /// How the stitch fits in `availableBytes`. `nil` when the platform
    /// imposes no per-process limit worth planning against.
    public func fit(sizes: PanoStitchSizes, availableBytes: Int?) -> PanoMemoryFit? {
        guard let availableBytes, availableBytes > 0, sizes.canvasWidth > 0, sizes.canvasHeight > 0 else {
            return nil
        }
        let full = estimatedPeakBytes(sizes: sizes, canvasWidth: sizes.canvasWidth)
        let budget = Int(Double(availableBytes) / Self.safetyFactor)
        guard full > budget else { return .fullFits(estimatedBytes: full) }
        guard headBytes(sizes) <= budget else { return .tooLarge(estimatedFullBytes: full) }

        let width = (budget - compositeBaseBytes(sizes)) / Self.compositeBytesPerCanvasColumn
        guard let canvas = sizes.fittedCanvas(width: width) else { return .tooLarge(estimatedFullBytes: full) }
        return .fitted(estimatedFullBytes: full, canvas: canvas)
    }

    func compositeBytes(_ sizes: PanoStitchSizes, canvasWidth: Int) -> Int {
        compositeBaseBytes(sizes) + canvasWidth * Self.compositeBytesPerCanvasColumn
    }

    func headBytes(_ sizes: PanoStitchSizes) -> Int {
        sizes.frameCount * Self.bytesPerFrame + sizes.largestFramePixels * Self.headBytesPerLargestFramePixel
    }

    private func compositeBaseBytes(_ sizes: PanoStitchSizes) -> Int {
        sizes.frameCount * Self.bytesPerFrame + sizes.largestFramePixels * Self.compositeBytesPerLargestFramePixel
    }
}

// MARK: - Available memory

public enum PanoAvailableMemory {
    /// Bytes the OS will still let this process allocate before it is
    /// terminated for memory, or `nil` where there is no such limit (macOS)
    /// or it is not reported (the iOS Simulator reports 0).
    public static func current() -> Int? {
        #if os(iOS) || os(tvOS) || os(visionOS)
        let available = Int(os_proc_available_memory())
        return available > 0 ? available : nil
        #else
        return nil
        #endif
    }
}
