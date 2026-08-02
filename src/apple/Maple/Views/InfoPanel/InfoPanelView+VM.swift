// InfoPanelView+VM.swift — pure derivations for S6 InfoPanelView.
//
// Co-located sibling of InfoPanelView.swift. Per the project convention
// (issue #192), every SwiftUI view with non-trivial derivation gets a
// `+VM.swift` sibling whose contents are unit-testable in isolation. To
// preserve that guarantee this file MUST NOT `import SwiftUI` — a grep
// gate in CI enforces it.
//
// What lives here:
//   • `cameraLocationRows` — projects an `ImageMetadataReader.ExifEntry`
//     array (the existing EXIF source-of-truth) into the spec's 8-row
//     Body/Lens/Aperture/Shutter/ISO/Focal/Coords/City grid, with "—"
//     fallback per row. Body folds Make + Model into one row.

import Foundation
import MapleCore

// MARK: - InfoPanelVM

enum InfoPanelVM {

  /// One row in the Camera & Location grid.
  struct Row: Identifiable, Equatable {
    let id: String  // stable label slug
    let label: String
    let value: String
  }

  /// Project EXIF entries into the Camera & Location grid. Missing rows
  /// render as "—" so the layout reserves consistent vertical space
  /// regardless of the image (a phone snapshot and a 100MP RAW with
  /// full GPS produce the same row count).
  ///
  /// `city` and `fileSize` come from the Self-Hosted rich-detail fetch
  /// (reverse-geocoded place + catalog size); `path` is the asset's display
  /// path (cloud abs-path or local filesystem path) and drives the clickable
  /// "Path" row. All three are `nil` for a plain local asset with no server
  /// detail — the rows then fall back to EXIF (Size/Path) or "—" (#2518).
  static func cameraLocationRows(
    from entries: [ImageMetadataReader.ExifEntry],
    city: String? = nil,
    fileSize: Int64? = nil,
    path: String? = nil
  ) -> [Row] {
    let make = value(entries, section: "Camera", label: "Make")
    let model = value(entries, section: "Camera", label: "Model")
    let lens = value(entries, section: "Camera", label: "Lens")
    let date = value(entries, section: "Camera", label: "Date Taken")
    let aper = value(entries, section: "Exposure", label: "Aperture")
    let shut = value(entries, section: "Exposure", label: "Shutter")
    let iso = value(entries, section: "Exposure", label: "ISO")
    let focal = value(entries, section: "Exposure", label: "Focal Length")
    let dimensions = value(entries, section: "Image", label: "Resolution")
    let lat = value(entries, section: "GPS", label: "Latitude")
    let lon = value(entries, section: "GPS", label: "Longitude")

    // Body folds Make + Model into one row — that's how users read
    // camera identity (the spec table says "Body (camera + model)").
    let body = combineMakeModel(make: make, model: model)

    // Coords pair lat + lon; City is the reverse-geocoded name from the
    // server place (falls back to "—" when un-geocoded / local).
    let coords = combineCoords(lat: lat, lon: lon)

    // Size: prefer the catalog size from the detail fetch (cloud), else the
    // EXIF File/Size row (local). Path: prefer the asset's display path, else
    // the EXIF File/Path row.
    let sizeValue = fileSize.map(formatBytes) ?? value(entries, section: "File", label: "Size")
    let pathValue = path ?? value(entries, section: "File", label: "Path")

    return [
      Row(id: "body", label: "Body", value: body),
      Row(id: "taken", label: "Taken", value: date ?? "—"),
      Row(id: "lens", label: "Lens", value: lens ?? "—"),
      Row(id: "aperture", label: "Aperture", value: aper ?? "—"),
      Row(id: "shutter", label: "Shutter", value: shut ?? "—"),
      Row(id: "iso", label: "ISO", value: iso ?? "—"),
      Row(id: "focal", label: "Focal", value: focal ?? "—"),
      Row(id: "dimensions", label: "Dimensions", value: dimensions ?? "—"),
      Row(id: "coords", label: "Coords", value: coords),
      Row(id: "city", label: "City", value: city ?? "—"),
      Row(id: "size", label: "Size", value: sizeValue ?? "—"),
      Row(id: "path", label: "Path", value: pathValue ?? "—"),
    ]
  }

  /// Human-readable byte count (e.g. "42.3 MB"), matching the EXIF File/Size
  /// formatting so cloud (detail fetch) and local (EXIF) rows read the same.
  static func formatBytes(_ bytes: Int64) -> String {
    let f = ByteCountFormatter()
    f.countStyle = .file
    return f.string(fromByteCount: bytes)
  }

  static func combineMakeModel(make: String?, model: String?) -> String {
    switch (make, model) {
    case (let m?, let n?):
      // Strip leading make prefix from the model when manufacturers
      // pre-pend it ("Canon EOS R5" with Make="Canon" → "Canon EOS R5",
      // not "Canon Canon EOS R5").
      let trimmedModel = n.hasPrefix(m + " ") ? n : (m + " " + n)
      return trimmedModel.trimmingCharacters(in: .whitespaces)
    case (let m?, nil):
      return m
    case (nil, let n?):
      return n
    default:
      return "—"
    }
  }

  static func combineCoords(lat: String?, lon: String?) -> String {
    switch (lat, lon) {
    case (let a?, let o?): return "\(a), \(o)"
    case (let a?, nil): return a
    case (nil, let o?): return o
    default: return "—"
    }
  }

  /// First matching entry's value, or `nil`.
  static func value(
    _ entries: [ImageMetadataReader.ExifEntry],
    section: String,
    label: String
  ) -> String? {
    entries.first(where: { $0.section == section && $0.label == label })?.value
  }
}
