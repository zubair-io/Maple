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
    public static func readPixelSize(from url: URL) -> PixelSize? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let width = number(props[kCGImagePropertyPixelWidth]),
              let height = number(props[kCGImagePropertyPixelHeight])
        else { return nil }
        let orientation = number(props[kCGImagePropertyOrientation]).map(Int.init)
        return orientedPixelSize(width: width, height: height, orientationValue: orientation)
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
