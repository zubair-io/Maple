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

public enum ImageMetadataReader {

    public struct AsShotWB: Sendable, Equatable {
        public var temperature: Double
        public var tint: Double
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
}
