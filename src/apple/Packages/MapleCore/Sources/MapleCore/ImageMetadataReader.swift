// ImageMetadataReader.swift — EXIF / DNG metadata lookup via Apple's
// `CIRAWFilter` and `ImageIO`. Used to read the camera's as-shot
// temperature + tint so the WB slider defaults to what the shot was
// actually metered at, not a hardcoded 6500 K.
//
// We never render with CIRAWFilter — decoding still goes through the
// Rust pipeline. The filter is constructed solely to read its
// `neutralTemperature` / `neutralTint` properties, which Apple derives
// from the file's `AsShotNeutral` tag with proper color science.

import Foundation
import CoreImage
import ImageIO

public enum ImageMetadataReader {

    public struct AsShotWB: Sendable, Equatable {
        public var temperature: Double
        public var tint: Double
    }

    public struct PixelSize: Sendable, Equatable {
        public var width: Double
        public var height: Double

        public var cgSize: CGSize {
            CGSize(width: width, height: height)
        }
    }

    /// Best-effort read of the as-shot white balance from a RAW / DNG URL.
    /// Returns `nil` when the file is not a recognized RAW or when the
    /// metadata is unavailable. Does **not** decode the image — the filter
    /// is used purely as a metadata parser.
    public static func readAsShotWB(from url: URL) -> AsShotWB? {
        guard let filter = CIRAWFilter(imageURL: url) else { return nil }
        let temp = Double(filter.neutralTemperature)
        let tint = Double(filter.neutralTint)
        guard temp.isFinite, temp > 1000, temp < 40000 else { return nil }
        return AsShotWB(temperature: temp, tint: tint)
    }

    /// Best-effort read of the display-oriented pixel dimensions from ImageIO
    /// metadata. This is intentionally metadata-only so the full-image view
    /// can lay out an embedded preview on the final virtual canvas before
    /// the expensive RAW decode finishes.
    ///
    /// Resolution strategy:
    ///   1. `CIRAWFilter.outputImage.extent` for RAW formats — Apple's RAW
    ///      filter knows how to surface the SENSOR dims (post-orientation).
    ///      This is the most reliable path for files where ImageIO's IFD 0
    ///      is an embedded JPEG preview rather than the sensor data (the
    ///      common case for camera DNGs and Apple ProRAW).
    ///   2. Otherwise, walk every subimage in the CGImageSource and pick
    ///      the LARGEST. Single-subimage formats (most JPEGs) have only
    ///      index 0; multi-subimage formats (DNG, HEIC) expose the full-
    ///      sensor data as a non-zero index, so reading index 0 alone
    ///      systematically underreports.
    ///
    /// Per CIImage docs, building a `CIRAWFilter` does NOT decode pixels;
    /// `outputImage.extent` is computed from metadata (cheap). User
    /// reported on iPad: 100 MP image → metadata returned 1040×693 (the
    /// embedded preview at IFD 0) → "100% zoom" rendered at preview size.
    /// Walking subimages or routing through CIRAWFilter fixes it.
    public static func readPixelSize(from url: URL) -> PixelSize? {
        // RAW path — fast extent read, doesn't decode pixels.
        if let filter = CIRAWFilter(imageURL: url),
           let img = filter.outputImage {
            let w = Double(img.extent.width)
            let h = Double(img.extent.height)
            if w > 0, h > 0 {
                // CIRAWFilter's outputImage.extent is already display-oriented.
                return PixelSize(width: w, height: h)
            }
        }
        // Fallback — walk every subimage, return the largest.
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let count = CGImageSourceGetCount(src)
        var best: (w: Double, h: Double, orient: Int?)? = nil
        for i in 0..<count {
            guard let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any],
                  let w = number(props[kCGImagePropertyPixelWidth]),
                  let h = number(props[kCGImagePropertyPixelHeight])
            else { continue }
            let curArea = best.map { $0.w * $0.h } ?? -1
            if w * h > curArea {
                let o = number(props[kCGImagePropertyOrientation]).map(Int.init)
                best = (w, h, o)
            }
        }
        guard let best else { return nil }
        return orientedPixelSize(width: best.w, height: best.h, orientationValue: best.orient)
    }

    static func orientedPixelSize(
        width: Double,
        height: Double,
        orientationValue: Int?
    ) -> PixelSize {
        switch orientationValue {
        case 5, 6, 7, 8:
            return PixelSize(width: height, height: width)
        default:
            return PixelSize(width: width, height: height)
        }
    }

    private static func number(_ value: Any?) -> Double? {
        switch value {
        case let n as NSNumber:
            return n.doubleValue
        case let n as Double:
            return n
        case let n as Int:
            return Double(n)
        default:
            return nil
        }
    }
}
