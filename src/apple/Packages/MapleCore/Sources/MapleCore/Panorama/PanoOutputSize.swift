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
    /// Full resolution does not fit, or on a phone exceeds its share of
    /// memory; this canvas, at the same aspect, does.
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
///   (features, matches, per-frame solve state) plus terms for the largest
///   frame (the banded decode and refinement windows);
/// - the composite — the per-frame state still held, terms for the largest
///   frame (its source taps), and a term proportional to canvas *width*: the
///   composite streams fixed-height strips whose buffers are output rows.
///
/// The model and its calibrations live in raw-core's `pano_memory`, which
/// `maple-pano` also refuses an over-limit server stitch with (#5835); they
/// reach here as `PanoMemoryCalibration` through `tools/codegen.sh`. The
/// sheet uses `.apple`, fitted to the iPad (#5555); `.server` is fitted to a
/// Mac's peak footprint and overstates an iPad about twofold (#5891). Every
/// input frame counts toward `frameCount`, dropped or not.
public struct PanoMemoryModel: Sendable, Equatable {
    /// Headroom for what the model does not see (allocator fragmentation,
    /// the app itself, thumbnail work running alongside).
    public static let safetyFactor = 1.15
    /// On an iPhone the sheet defaults to Smaller once the full-size peak
    /// exceeds this share of available memory (#5654). The 1.15 headroom is
    /// calibrated on a Mac allocator and iPad runs, not on a phone sharing
    /// memory with a running backup.
    public static let phoneSmallerDefaultFraction = 0.6

    /// Share of available memory above which a smaller output is offered
    /// ahead of the hard limit, `nil` where only the hard limit applies.
    public let smallerDefaultFraction: Double?
    /// The constants the model is evaluated with.
    public let calibration: PanoMemoryCalibration

    public init(smallerDefaultFraction: Double? = nil, calibration: PanoMemoryCalibration = .apple) {
        self.smallerDefaultFraction = smallerDefaultFraction
        self.calibration = calibration
    }

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
        let hardBudget = Int(Double(availableBytes) / Self.safetyFactor)
        let defaultBudget = min(hardBudget, smallerDefaultFraction.map { Int(Double(availableBytes) * $0) } ?? hardBudget)
        guard full > defaultBudget else { return .fullFits(estimatedBytes: full) }

        let head = headBytes(sizes)
        let budgets = full > hardBudget ? [defaultBudget, hardBudget] : [defaultBudget]
        for budget in budgets where head <= budget {
            let width = (budget - compositeBaseBytes(sizes)) / calibration.compositeBytesPerCanvasColumn
            if let canvas = sizes.fittedCanvas(width: width) {
                return .fitted(estimatedFullBytes: full, canvas: canvas)
            }
        }
        return full > hardBudget ? .tooLarge(estimatedFullBytes: full) : .fullFits(estimatedBytes: full)
    }

    func compositeBytes(_ sizes: PanoStitchSizes, canvasWidth: Int) -> Int {
        compositeBaseBytes(sizes) + canvasWidth * calibration.compositeBytesPerCanvasColumn
    }

    func headBytes(_ sizes: PanoStitchSizes) -> Int {
        phaseBytes(
            sizes,
            perFrame: calibration.headBytesPerFrame,
            perProxyPixel: calibration.headBytesPerFrameProxyPixel,
            perPixel: calibration.headBytesPerLargestFramePixel,
            perColumn: calibration.headBytesPerLargestFrameColumn)
    }

    private func compositeBaseBytes(_ sizes: PanoStitchSizes) -> Int {
        phaseBytes(
            sizes,
            perFrame: calibration.compositeBytesPerFrame,
            perProxyPixel: calibration.compositeBytesPerFrameProxyPixel,
            perPixel: calibration.compositeBytesPerLargestFramePixel,
            perColumn: calibration.compositeBytesPerLargestFrameColumn)
    }

    private func phaseBytes(_ sizes: PanoStitchSizes, perFrame: Int, perProxyPixel: Int, perPixel: Int, perColumn: Int)
        -> Int
    {
        let proxyPixels = min(sizes.largestFramePixels, PanoMemoryCalibration.proxyPixelsMax)
        return sizes.frameCount * (perFrame + proxyPixels * perProxyPixel)
            + sizes.largestFramePixels * perPixel
            + Self.frameColumns(sizes.largestFramePixels) * perColumn
    }

    /// The width of a 3:2 frame of `pixels`, as raw-core's `frame_columns`:
    /// the integer square root of 1.5 × `pixels`.
    static func frameColumns(_ pixels: Int) -> Int {
        let n = pixels * 3 / 2
        var root = Int(Double(n).squareRoot())
        while root * root > n { root -= 1 }
        while (root + 1) * (root + 1) <= n { root += 1 }
        return root
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
