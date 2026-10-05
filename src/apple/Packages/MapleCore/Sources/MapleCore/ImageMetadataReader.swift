// ImageMetadataReader.swift — EXIF / DNG metadata lookup via Apple's
// `CIRAWFilter` and `ImageIO`. Used to read the camera's as-shot
// temperature + tint so the WB slider defaults to what the shot was
// actually metered at, not a hardcoded 6500 K.
//
// We never render with CIRAWFilter — decoding still goes through the
// Rust pipeline. The filter is constructed solely to read its
// `neutralTemperature` / `neutralTint` properties, which Apple derives
// from the file's `AsShotNeutral` tag with proper color science.

import CoreImage
import Foundation
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
      let img = filter.outputImage
    {
      let w = Double(img.extent.width)
      let h = Double(img.extent.height)
      if w > 0, h > 0 {
        // CIRAWFilter's outputImage.extent is already display-oriented.
        return PixelSize(width: w, height: h)
      }
    }
    // ImageIO fallback — walk every subimage, return the largest.
    if let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let size = largestSubimageSize(in: src)
    {
      return size
    }
    // Direct TIFF / DNG header fallback for synthetic CFA files where
    // CIRAWFilter and ImageIO both decline to discover pixel dims.
    return readTiffPixelSize(from: url)
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
      let img = filter.outputImage
    {
      let w = Double(img.extent.width)
      let h = Double(img.extent.height)
      if w > 0, h > 0 {
        return PixelSize(width: w, height: h)
      }
    }
    // ImageIO fallback — walk every subimage, return the largest.
    if let src = CGImageSourceCreateWithData(data as CFData, nil),
      let size = largestSubimageSize(in: src)
    {
      return size
    }
    // Direct TIFF / DNG header fallback for synthetic CFA files where
    // CIRAWFilter and ImageIO both decline to discover pixel dims.
    return readTiffPixelSize(from: data)
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

  static func number(_ value: Any?) -> Double? {
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

  /// Pick the subimage whose properties dictionary the Info tab should
  /// read. We use the largest-by-pixel-area (same as readPixelSize) so the
  /// EXIF dictionary attached to the SENSOR data wins, not the embedded
  /// JPEG preview's. Fall back to index 0 when no subimage has a usable
  /// pixel-size pair.
  ///
  /// `internal` (not `private`): shared with
  /// `ImageMetadataReader+CameraSerial.swift` (#2656), which reads the
  /// same best-subimage EXIF dictionary for the body serial number and
  /// needs the identical multi-IFD DNG handling `readRawCaptureDateStrings`
  /// already gets right.
  static func bestSubimageIndex(in src: CGImageSource) -> Int {
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

}
