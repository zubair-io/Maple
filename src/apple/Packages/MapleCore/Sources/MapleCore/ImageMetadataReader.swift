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
import UniformTypeIdentifiers

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

    /// Single key/value pair extracted from an image's metadata. The list
    /// preserves the order the reader used so callers (the Info tab) can
    /// display sections in a stable layout. Both `label` and `value` are
    /// pre-formatted strings ready for direct display — fractions, dates,
    /// and aperture stops are rendered into human shape by the reader.
    public struct ExifEntry: Sendable, Equatable, Identifiable {
        public var id: String { "\(section)-\(label)" }
        public var section: String
        public var label: String
        public var value: String

        public init(section: String, label: String, value: String) {
            self.section = section
            self.label = label
            self.value = value
        }
    }

    /// Raw (unformatted) EXIF capture-date strings as ImageIO surfaces them
    /// — `"YYYY:MM:DD HH:MM:SS"`, untouched. Used by maple_id primary-form
    /// derivation (`ExifCaptureDate.iso8601UTC`, #1995), which needs the RAW
    /// tag value, not `formatExifDate`'s human-display reformatting (that
    /// helper is a DISPLAY formatter for the Info tab and its output isn't
    /// guaranteed to stay in a shape `ExifCaptureDate` can re-parse).
    public struct RawCaptureDateStrings: Sendable, Equatable {
        /// `kCGImagePropertyExifDateTimeOriginal` — exifr's `DateTimeOriginal`.
        public var dateTimeOriginal: String?
        /// `kCGImagePropertyExifDateTimeDigitized` — exifr's `CreateDate`.
        public var createDate: String?
    }

    /// Read the raw EXIF `DateTimeOriginal` / `DateTimeDigitized` strings
    /// from a URL, from whichever subimage `bestSubimageIndex` picks (the
    /// largest-by-pixel-area one — the sensor data's EXIF dictionary for
    /// multi-IFD DNGs, not the embedded JPEG preview's at IFD 0). Mirrors the
    /// preference order the server indexer's `normalizeExif` uses
    /// (`asIsoDate(DateTimeOriginal) ?? asIsoDate(CreateDate)`,
    /// `src/api/src/indexer/exif.ts`) — callers should try
    /// `dateTimeOriginal` first and fall back to `createDate` only when the
    /// first is absent or fails to parse.
    ///
    /// Returns a struct with both fields `nil` when the file can't be opened
    /// or carries no EXIF dictionary at all.
    public static func readRawCaptureDateStrings(from url: URL) -> RawCaptureDateStrings {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            return RawCaptureDateStrings(dateTimeOriginal: nil, createDate: nil)
        }
        return readRawCaptureDateStrings(from: src)
    }

    /// Sourceless variant of `readRawCaptureDateStrings(from url:)` for
    /// assets surfaced through `bytesProvider` (PhotoKit, Self-Hosted) where
    /// no stable URL exists.
    public static func readRawCaptureDateStrings(from data: Data) -> RawCaptureDateStrings {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else {
            return RawCaptureDateStrings(dateTimeOriginal: nil, createDate: nil)
        }
        return readRawCaptureDateStrings(from: src)
    }

    private static func readRawCaptureDateStrings(from src: CGImageSource) -> RawCaptureDateStrings {
        let index = bestSubimageIndex(in: src)
        guard let raw = CGImageSourceCopyPropertiesAtIndex(src, index, nil) as? [CFString: Any],
              let exif = raw[kCGImagePropertyExifDictionary] as? [CFString: Any]
        else {
            return RawCaptureDateStrings(dateTimeOriginal: nil, createDate: nil)
        }
        return RawCaptureDateStrings(
            dateTimeOriginal: exif[kCGImagePropertyExifDateTimeOriginal] as? String,
            createDate: exif[kCGImagePropertyExifDateTimeDigitized] as? String
        )
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
        return largestSubimageSize(in: src)
    }

    /// Sourceless variant of `readPixelSize(from url:)` for assets surfaced
    /// through `bytesProvider` (PhotoKit, Self-Hosted) where no stable URL
    /// exists. Walks every subimage exactly like the URL path so multi-IFD
    /// DNGs return sensor dims, not the embedded preview at IFD 0.
    ///
    /// `identifierHint` is the file's UTI (e.g. "com.adobe.raw-image") or a
    /// best-effort guess derived from the source's hint extension. Apple's
    /// `CIRAWFilter` needs it to pick the right RAW backend when there's no
    /// URL to sniff. `nil` is allowed — CIRAWFilter will decline and the
    /// CGImageSource fallback handles non-RAW formats.
    public static func readPixelSize(from data: Data, identifierHint: String? = nil) -> PixelSize? {
        // RAW path — same metadata-only extent read as the URL variant.
        if let filter = makeRAWFilter(data: data, identifierHint: identifierHint),
           let img = filter.outputImage {
            let w = Double(img.extent.width)
            let h = Double(img.extent.height)
            if w > 0, h > 0 {
                return PixelSize(width: w, height: h)
            }
        }
        // Fallback — walk every subimage, return the largest.
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return largestSubimageSize(in: src)
    }

    /// Walks every subimage in a CGImageSource and returns the orientation-
    /// adjusted size of the largest one. Shared between the URL and Data
    /// readPixelSize variants so the multi-IFD DNG handling is identical.
    private static func largestSubimageSize(in src: CGImageSource) -> PixelSize? {
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

    /// Build a CIRAWFilter from raw bytes when the source has no URL.
    /// Returns `nil` for non-RAW data — callers should fall through to the
    /// CGImageSource path. CIRAWFilter requires a Uniform Type Identifier
    /// (e.g. `"com.adobe.raw-image"`) — a bare extension (`"dng"`) makes
    /// it return `nil` and silently fall through to the embedded preview,
    /// which is exactly the bug we're trying to avoid. Map the common
    /// extensions to their UTI here.
    private static func makeRAWFilter(data: Data, identifierHint: String?) -> CIRAWFilter? {
        guard let raw = identifierHint?.lowercased(), !raw.isEmpty else { return nil }
        // Already a UTI — pass through. Anything containing a "." that's
        // not a leading dot is presumed to be a UTI (`com.adobe.raw-image`,
        // `public.tiff`).
        if raw.contains(".") {
            return CIRAWFilter(imageData: data, identifierHint: raw)
        }
        // Resolve via UniformTypeIdentifiers — the modern path. Falls
        // through to nil for unknown extensions; the caller will use the
        // CGImageSource fallback in that case.
        guard let type = UTType(filenameExtension: raw),
              let identifier = type.identifier as String?
        else { return nil }
        return CIRAWFilter(imageData: data, identifierHint: identifier)
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

    // MARK: - EXIF properties (Info tab)

    /// Read every EXIF / TIFF / GPS field that ImageIO surfaces from a URL
    /// and return them as an ordered list of pre-formatted entries ready for
    /// display in the DetailPanel's Info tab. Includes file-size + path rows
    /// the caller doesn't have to compose separately.
    ///
    /// Returns an empty array when the file can't be opened or has no usable
    /// metadata — the Info tab simply shows nothing for that section.
    public static func readExifProperties(from url: URL) -> [ExifEntry] {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return [] }
        let bestIndex = bestSubimageIndex(in: src)
        var entries = exifEntries(from: src, index: bestIndex)
        // Augment with file rows the dictionary doesn't carry.
        let fileEntries = fileSystemEntries(for: url)
        // File section comes last in display order — Image first, Camera,
        // Exposure, GPS, then File metadata. Append.
        entries.append(contentsOf: fileEntries)
        return entries
    }

    /// Sourceless variant of `readExifProperties(from url:)`. Used by the
    /// Info tab when an asset is surfaced through `bytesProvider` (PhotoKit,
    /// Self-Hosted). `byteCount` and `displayPath` let the caller surface
    /// File-section rows that aren't in the image dictionary.
    public static func readExifProperties(
        from data: Data,
        byteCount: Int? = nil,
        displayPath: String? = nil
    ) -> [ExifEntry] {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return [] }
        let bestIndex = bestSubimageIndex(in: src)
        var entries = exifEntries(from: src, index: bestIndex)
        if let byteCount {
            entries.append(ExifEntry(section: "File", label: "Size",
                                     value: formatBytes(Int64(byteCount))))
        }
        if let displayPath, !displayPath.isEmpty {
            entries.append(ExifEntry(section: "File", label: "Path", value: displayPath))
        }
        return entries
    }

    /// Pick the subimage whose properties dictionary the Info tab should
    /// read. We use the largest-by-pixel-area (same as readPixelSize) so the
    /// EXIF dictionary attached to the SENSOR data wins, not the embedded
    /// JPEG preview's. Fall back to index 0 when no subimage has a usable
    /// pixel-size pair.
    private static func bestSubimageIndex(in src: CGImageSource) -> Int {
        let count = CGImageSourceGetCount(src)
        var best: (idx: Int, area: Double)? = nil
        for i in 0..<count {
            guard let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any],
                  let w = number(props[kCGImagePropertyPixelWidth]),
                  let h = number(props[kCGImagePropertyPixelHeight])
            else { continue }
            let area = w * h
            if best == nil || area > best!.area {
                best = (i, area)
            }
        }
        return best?.idx ?? 0
    }

    /// Pull EXIF / TIFF / GPS sub-dictionaries out of the property dict at
    /// the given index and format the interesting fields. Non-trivial
    /// formatting (shutter as a fraction, aperture as f/N, dates as
    /// human-readable, GPS as signed decimal) is centralised here so the
    /// Info tab only needs to render rows.
    private static func exifEntries(from src: CGImageSource, index: Int) -> [ExifEntry] {
        guard let raw = CGImageSourceCopyPropertiesAtIndex(src, index, nil) as? [CFString: Any] else {
            return []
        }

        var out: [ExifEntry] = []

        // Image — pixel dimensions are the headline row.
        if let w = number(raw[kCGImagePropertyPixelWidth]),
           let h = number(raw[kCGImagePropertyPixelHeight]) {
            let orient = number(raw[kCGImagePropertyOrientation]).map(Int.init)
            let display = orientedPixelSize(width: w, height: h, orientationValue: orient)
            out.append(ExifEntry(
                section: "Image",
                label: "Resolution",
                value: "\(Int(display.width)) × \(Int(display.height))"
            ))
            let mp = (display.width * display.height) / 1_000_000.0
            if mp >= 0.1 {
                out.append(ExifEntry(
                    section: "Image",
                    label: "Megapixels",
                    value: String(format: "%.1f MP", mp)
                ))
            }
        }
        if let depth = number(raw[kCGImagePropertyDepth]) {
            out.append(ExifEntry(section: "Image", label: "Bit Depth",
                                 value: String(format: "%.0f", depth)))
        }
        if let model = raw[kCGImagePropertyColorModel] as? String {
            out.append(ExifEntry(section: "Image", label: "Color Model", value: model))
        }
        if let profile = raw[kCGImagePropertyProfileName] as? String {
            out.append(ExifEntry(section: "Image", label: "Profile", value: profile))
        }

        // TIFF — camera identity + capture date.
        if let tiff = raw[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            if let make = tiff[kCGImagePropertyTIFFMake] as? String {
                out.append(ExifEntry(section: "Camera", label: "Make", value: make.trimmingCharacters(in: .whitespaces)))
            }
            if let model = tiff[kCGImagePropertyTIFFModel] as? String {
                out.append(ExifEntry(section: "Camera", label: "Model", value: model.trimmingCharacters(in: .whitespaces)))
            }
            if let software = tiff[kCGImagePropertyTIFFSoftware] as? String {
                out.append(ExifEntry(section: "Camera", label: "Software", value: software))
            }
            if let artist = tiff[kCGImagePropertyTIFFArtist] as? String {
                out.append(ExifEntry(section: "Camera", label: "Artist", value: artist))
            }
            if let copyright = tiff[kCGImagePropertyTIFFCopyright] as? String {
                out.append(ExifEntry(section: "Camera", label: "Copyright", value: copyright))
            }
        }

        // EXIF — exposure parameters.
        if let exif = raw[kCGImagePropertyExifDictionary] as? [CFString: Any] {
            if let dateStr = exif[kCGImagePropertyExifDateTimeOriginal] as? String {
                out.append(ExifEntry(section: "Camera", label: "Date Taken",
                                     value: formatExifDate(dateStr)))
            } else if let dateStr = exif[kCGImagePropertyExifDateTimeDigitized] as? String {
                out.append(ExifEntry(section: "Camera", label: "Date Taken",
                                     value: formatExifDate(dateStr)))
            }
            if let lens = exif[kCGImagePropertyExifLensModel] as? String {
                out.append(ExifEntry(section: "Camera", label: "Lens", value: lens))
            } else if let lensMake = exif[kCGImagePropertyExifLensMake] as? String {
                out.append(ExifEntry(section: "Camera", label: "Lens", value: lensMake))
            }

            if let focal = number(exif[kCGImagePropertyExifFocalLength]) {
                out.append(ExifEntry(
                    section: "Exposure",
                    label: "Focal Length",
                    value: String(format: "%.0f mm", focal)
                ))
            }
            if let focal35 = number(exif[kCGImagePropertyExifFocalLenIn35mmFilm]), focal35 > 0 {
                out.append(ExifEntry(
                    section: "Exposure",
                    label: "Focal (35mm)",
                    value: String(format: "%.0f mm", focal35)
                ))
            }
            if let aperture = number(exif[kCGImagePropertyExifFNumber]) {
                out.append(ExifEntry(
                    section: "Exposure",
                    label: "Aperture",
                    value: String(format: "f/%.1f", aperture)
                ))
            }
            if let shutter = number(exif[kCGImagePropertyExifExposureTime]) {
                out.append(ExifEntry(
                    section: "Exposure",
                    label: "Shutter",
                    value: formatShutter(shutter)
                ))
            }
            if let isoArray = exif[kCGImagePropertyExifISOSpeedRatings] as? [Any],
               let iso = isoArray.compactMap({ number($0) }).first {
                out.append(ExifEntry(
                    section: "Exposure",
                    label: "ISO",
                    value: String(format: "%.0f", iso)
                ))
            }
            if let bias = number(exif[kCGImagePropertyExifExposureBiasValue]) {
                out.append(ExifEntry(
                    section: "Exposure",
                    label: "Exposure Bias",
                    value: String(format: "%+.1f EV", bias)
                ))
            }
            if let metering = number(exif[kCGImagePropertyExifMeteringMode]) {
                out.append(ExifEntry(
                    section: "Exposure",
                    label: "Metering",
                    value: meteringMode(Int(metering))
                ))
            }
            if let flash = number(exif[kCGImagePropertyExifFlash]) {
                out.append(ExifEntry(
                    section: "Exposure",
                    label: "Flash",
                    value: flashDescription(Int(flash))
                ))
            }
            if let wbValue = number(exif[kCGImagePropertyExifWhiteBalance]) {
                out.append(ExifEntry(
                    section: "Exposure",
                    label: "White Balance",
                    value: Int(wbValue) == 0 ? "Auto" : "Manual"
                ))
            }
        }

        // GPS — when present.
        if let gps = raw[kCGImagePropertyGPSDictionary] as? [CFString: Any] {
            if let lat = number(gps[kCGImagePropertyGPSLatitude]),
               let latRef = gps[kCGImagePropertyGPSLatitudeRef] as? String {
                let signed = latRef.uppercased() == "S" ? -lat : lat
                out.append(ExifEntry(
                    section: "GPS",
                    label: "Latitude",
                    value: String(format: "%.6f°", signed)
                ))
            }
            if let lon = number(gps[kCGImagePropertyGPSLongitude]),
               let lonRef = gps[kCGImagePropertyGPSLongitudeRef] as? String {
                let signed = lonRef.uppercased() == "W" ? -lon : lon
                out.append(ExifEntry(
                    section: "GPS",
                    label: "Longitude",
                    value: String(format: "%.6f°", signed)
                ))
            }
            if let alt = number(gps[kCGImagePropertyGPSAltitude]) {
                let ref = number(gps[kCGImagePropertyGPSAltitudeRef]).map(Int.init) ?? 0
                let signed = ref == 1 ? -alt : alt
                out.append(ExifEntry(
                    section: "GPS",
                    label: "Altitude",
                    value: String(format: "%.0f m", signed)
                ))
            }
        }

        return out
    }

    private static func fileSystemEntries(for url: URL) -> [ExifEntry] {
        var out: [ExifEntry] = []
        if let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
           let size = values.fileSize {
            out.append(ExifEntry(section: "File", label: "Size",
                                 value: formatBytes(Int64(size))))
        }
        out.append(ExifEntry(section: "File", label: "Path", value: url.path))
        return out
    }

    private static func formatBytes(_ count: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: count)
    }

    /// EXIF-format dates are "YYYY:MM:DD HH:MM:SS" — convert to a more
    /// readable "YYYY-MM-DD HH:MM:SS". Returns the input unchanged when
    /// parsing fails so we never lose the data.
    private static func formatExifDate(_ s: String) -> String {
        let trimmed = s.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 10 else { return trimmed }
        let chars = Array(trimmed)
        // Replace the first two ':' (date separators) with '-'. Time half
        // keeps its colons.
        var out = chars
        if out[4] == ":" { out[4] = "-" }
        if out.count > 7, out[7] == ":" { out[7] = "-" }
        return String(out)
    }

    /// Render an EXIF shutter (seconds, decimal) as either "1/250 s" for
    /// values < 1 or "0.5 s" for fractional and "2 s" for integer values
    /// ≥ 1.
    private static func formatShutter(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "—" }
        if seconds >= 1 {
            // Integer or single-decimal seconds.
            if abs(seconds - seconds.rounded()) < 0.05 {
                return String(format: "%.0f s", seconds)
            }
            return String(format: "%.1f s", seconds)
        }
        // Sub-second exposure → reciprocal as a fraction.
        let denom = (1.0 / seconds).rounded()
        return "1/\(Int(denom)) s"
    }

    private static func meteringMode(_ value: Int) -> String {
        switch value {
        case 0: return "Unknown"
        case 1: return "Average"
        case 2: return "Center-weighted"
        case 3: return "Spot"
        case 4: return "Multi-spot"
        case 5: return "Pattern"
        case 6: return "Partial"
        case 255: return "Other"
        default: return "Mode \(value)"
        }
    }

    private static func flashDescription(_ value: Int) -> String {
        // Flash byte: bit 0 = fired, bit 5 = no-flash function, etc.
        let fired = (value & 0x1) != 0
        let didNotFire = (value & 0x20) != 0
        if didNotFire { return "Did not fire" }
        return fired ? "Fired" : "Did not fire"
    }
}
