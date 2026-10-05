// ImageMetadataReader+Exif.swift — EXIF / TIFF / GPS properties formatting
// for the Info tab.

import CoreGraphics
import Foundation
import ImageIO

extension ImageMetadataReader {

  /// Walk the file's properties dictionaries and pull out human-formatted
  /// strings for the Info tab. Sections match the desktop app's layout:
  /// Image, Camera, Exposure, GPS, File. File rows are generated from the
  /// URL (size on disk, path) and appended to the metadata-derived rows so
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
      entries.append(
        ExifEntry(
          section: "File", label: "Size",
          value: formatBytes(Int64(byteCount))))
    }
    if let displayPath, !displayPath.isEmpty {
      entries.append(ExifEntry(section: "File", label: "Path", value: displayPath))
    }
    return entries
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
      let h = number(raw[kCGImagePropertyPixelHeight])
    {
      let orient = number(raw[kCGImagePropertyOrientation]).map(Int.init)
      let display = orientedPixelSize(width: w, height: h, orientationValue: orient)
      out.append(
        ExifEntry(
          section: "Image",
          label: "Resolution",
          value: "\(Int(display.width)) × \(Int(display.height))"
        ))
      let mp = (display.width * display.height) / 1_000_000.0
      if mp >= 0.1 {
        out.append(
          ExifEntry(
            section: "Image",
            label: "Megapixels",
            value: String(format: "%.1f MP", mp)
          ))
      }
    }
    if let depth = number(raw[kCGImagePropertyDepth]) {
      out.append(
        ExifEntry(
          section: "Image", label: "Bit Depth",
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
        out.append(
          ExifEntry(
            section: "Camera", label: "Make", value: make.trimmingCharacters(in: .whitespaces)))
      }
      if let model = tiff[kCGImagePropertyTIFFModel] as? String {
        out.append(
          ExifEntry(
            section: "Camera", label: "Model", value: model.trimmingCharacters(in: .whitespaces)))
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
        out.append(
          ExifEntry(
            section: "Camera", label: "Date Taken",
            value: formatExifDate(dateStr)))
      } else if let dateStr = exif[kCGImagePropertyExifDateTimeDigitized] as? String {
        out.append(
          ExifEntry(
            section: "Camera", label: "Date Taken",
            value: formatExifDate(dateStr)))
      }
      if let lens = exif[kCGImagePropertyExifLensModel] as? String {
        out.append(ExifEntry(section: "Camera", label: "Lens", value: lens))
      } else if let lensMake = exif[kCGImagePropertyExifLensMake] as? String {
        out.append(ExifEntry(section: "Camera", label: "Lens", value: lensMake))
      }

      if let focal = number(exif[kCGImagePropertyExifFocalLength]) {
        out.append(
          ExifEntry(
            section: "Exposure",
            label: "Focal Length",
            value: String(format: "%.0f mm", focal)
          ))
      }
      if let focal35 = number(exif[kCGImagePropertyExifFocalLenIn35mmFilm]), focal35 > 0 {
        out.append(
          ExifEntry(
            section: "Exposure",
            label: "Focal (35mm)",
            value: String(format: "%.0f mm", focal35)
          ))
      }
      if let aperture = number(exif[kCGImagePropertyExifFNumber]) {
        out.append(
          ExifEntry(
            section: "Exposure",
            label: "Aperture",
            value: String(format: "f/%.1f", aperture)
          ))
      }
      if let shutter = number(exif[kCGImagePropertyExifExposureTime]) {
        out.append(
          ExifEntry(
            section: "Exposure",
            label: "Shutter",
            value: formatShutter(shutter)
          ))
      }
      if let isoArray = exif[kCGImagePropertyExifISOSpeedRatings] as? [Any],
        let iso = isoArray.compactMap({ number($0) }).first
      {
        out.append(
          ExifEntry(
            section: "Exposure",
            label: "ISO",
            value: String(format: "%.0f", iso)
          ))
      }
      if let bias = number(exif[kCGImagePropertyExifExposureBiasValue]) {
        out.append(
          ExifEntry(
            section: "Exposure",
            label: "Exposure Bias",
            value: String(format: "%+.1f EV", bias)
          ))
      }
      if let metering = number(exif[kCGImagePropertyExifMeteringMode]) {
        out.append(
          ExifEntry(
            section: "Exposure",
            label: "Metering",
            value: meteringMode(Int(metering))
          ))
      }
      if let flash = number(exif[kCGImagePropertyExifFlash]) {
        out.append(
          ExifEntry(
            section: "Exposure",
            label: "Flash",
            value: flashDescription(Int(flash))
          ))
      }
      if let wbValue = number(exif[kCGImagePropertyExifWhiteBalance]) {
        out.append(
          ExifEntry(
            section: "Exposure",
            label: "White Balance",
            value: Int(wbValue) == 0 ? "Auto" : "Manual"
          ))
      }
    }

    // GPS — when present.
    if let gps = raw[kCGImagePropertyGPSDictionary] as? [CFString: Any] {
      if let lat = number(gps[kCGImagePropertyGPSLatitude]),
        let latRef = gps[kCGImagePropertyGPSLatitudeRef] as? String
      {
        let signed = latRef.uppercased() == "S" ? -lat : lat
        out.append(
          ExifEntry(
            section: "GPS",
            label: "Latitude",
            value: String(format: "%.6f°", signed)
          ))
      }
      if let lon = number(gps[kCGImagePropertyGPSLongitude]),
        let lonRef = gps[kCGImagePropertyGPSLongitudeRef] as? String
      {
        let signed = lonRef.uppercased() == "W" ? -lon : lon
        out.append(
          ExifEntry(
            section: "GPS",
            label: "Longitude",
            value: String(format: "%.6f°", signed)
          ))
      }
      if let alt = number(gps[kCGImagePropertyGPSAltitude]) {
        let ref = number(gps[kCGImagePropertyGPSAltitudeRef]).map(Int.init) ?? 0
        let signed = ref == 1 ? -alt : alt
        out.append(
          ExifEntry(
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
      let size = values.fileSize
    {
      out.append(
        ExifEntry(
          section: "File", label: "Size",
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
