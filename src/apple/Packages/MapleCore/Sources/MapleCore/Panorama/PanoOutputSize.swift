// PanoOutputSize.swift — Will the full stitch fit in this device's memory,
// and how small does the output have to be if not (#5454).
//
// The preview reports what the full stitch will hold (`PanoStitchSizes`).
// `PanoMemoryModel` turns that into a peak-memory estimate and, when the
// estimate exceeds the memory the OS will still grant this process, the
// largest output canvas that fits. Only the composite's share shrinks with
// the canvas: decode and refinement work on full-resolution frames
// whatever the output size, so some sets cannot fit at any size.

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

    public init(canvasWidth: Int, canvasHeight: Int, largestFramePixels: Int) {
        self.canvasWidth = canvasWidth
        self.canvasHeight = canvasHeight
        self.largestFramePixels = largestFramePixels
    }
}

// MARK: - PanoOutputSize

/// The user's output-size choice in the merge sheet.
public enum PanoOutputSize: String, Sendable, CaseIterable {
    case full
    /// The largest canvas the memory model says fits this device.
    case fitted
}

// MARK: - PanoMemoryFit

public enum PanoMemoryFit: Sendable, Equatable {
    /// Full resolution fits.
    case fullFits(estimatedBytes: Int)
    /// Full resolution does not fit; a canvas of at most `canvasPixels`
    /// (`width × height`, same aspect) does.
    case fitted(estimatedFullBytes: Int, canvasPixels: Int, width: Int, height: Int)
    /// Not even a preview-sized canvas fits: the frames alone exceed it.
    case tooLarge(estimatedFullBytes: Int)
}

// MARK: - PanoMemoryModel

/// Peak physical footprint of a full stitch: the larger of
///
/// - a refinement floor — decode and refinement work on full-resolution
///   frames (refinement in bands, since #5563) whatever the output size, so
///   it scales with the largest frame;
/// - the composite — a base the allocator still holds from those stages
///   (also per frame pixel) plus a term proportional to canvas *width*. Width,
///   not area, because the composite streams fixed-height strips whose
///   buffers are output rows; the two measurements below halve both axes, so
///   they fit an area model too and do not by themselves choose between them.
///
/// Calibrated with `maple-cli` on pano_01 (21 × 20.8 MP frames, classical
/// matcher, #5454): refinement peaks at 2.31 GiB; the composite at
/// 2.77 GiB for a 26981 px wide canvas and 2.15 GiB at 13490 px. Those
/// figures predate banded refinement (#5563), so the refinement floor now
/// overstates that stage. Frame count is not a term — decode holds one frame
/// at a time — but only the 21-frame set has been measured.
public struct PanoMemoryModel: Sendable, Equatable {
    public static let refineBytesPerFramePixel = 119
    public static let compositeBaseBytesPerFramePixel = 79
    public static let compositeBytesPerCanvasColumn = 49_350
    /// Headroom for what the model does not see (allocator fragmentation,
    /// the app itself, thumbnail work running alongside).
    public static let safetyFactor = 1.15
    /// Below this the output is no larger than the preview already shown.
    public static let smallestUsefulLongEdge = 2048

    public init() {}

    public func estimatedPeakBytes(sizes: PanoStitchSizes, canvasWidth: Int) -> Int {
        max(refineFloorBytes(sizes), compositeBaseBytes(sizes) + canvasWidth * Self.compositeBytesPerCanvasColumn)
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
        guard refineFloorBytes(sizes) <= budget else { return .tooLarge(estimatedFullBytes: full) }

        let width = (budget - compositeBaseBytes(sizes)) / Self.compositeBytesPerCanvasColumn
        let height = Int((Double(sizes.canvasHeight) * Double(width) / Double(sizes.canvasWidth)).rounded(.down))
        guard max(width, height) >= Self.smallestUsefulLongEdge else {
            return .tooLarge(estimatedFullBytes: full)
        }
        return .fitted(estimatedFullBytes: full, canvasPixels: width * height, width: width, height: height)
    }

    private func refineFloorBytes(_ sizes: PanoStitchSizes) -> Int {
        sizes.largestFramePixels * Self.refineBytesPerFramePixel
    }

    private func compositeBaseBytes(_ sizes: PanoStitchSizes) -> Int {
        sizes.largestFramePixels * Self.compositeBaseBytesPerFramePixel
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
