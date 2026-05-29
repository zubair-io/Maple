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

  /// Project EXIF entries into the spec's 8-row grid. Missing rows
  /// render as "—" so the layout reserves consistent vertical space
  /// regardless of the image (a phone snapshot and a 100MP RAW with
  /// full GPS produce the same row count).
  static func cameraLocationRows(
    from entries: [ImageMetadataReader.ExifEntry]
  ) -> [Row] {
    let make = value(entries, section: "Camera", label: "Make")
    let model = value(entries, section: "Camera", label: "Model")
    let lens = value(entries, section: "Camera", label: "Lens")
    let aper = value(entries, section: "Exposure", label: "Aperture")
    let shut = value(entries, section: "Exposure", label: "Shutter")
    let iso = value(entries, section: "Exposure", label: "ISO")
    let focal = value(entries, section: "Exposure", label: "Focal Length")
    let lat = value(entries, section: "GPS", label: "Latitude")
    let lon = value(entries, section: "GPS", label: "Longitude")

    // Body folds Make + Model into one row — that's how users read
    // camera identity (the spec table says "Body (camera + model)").
    let body = combineMakeModel(make: make, model: model)

    // Coords pair lat + lon. City would come from a reverse geocode
    // — not wired into MapleCore today; show raw coords for v0.1.
    let coords = combineCoords(lat: lat, lon: lon)

    return [
      Row(id: "body", label: "Body", value: body),
      Row(id: "lens", label: "Lens", value: lens ?? "—"),
      Row(id: "aperture", label: "Aperture", value: aper ?? "—"),
      Row(id: "shutter", label: "Shutter", value: shut ?? "—"),
      Row(id: "iso", label: "ISO", value: iso ?? "—"),
      Row(id: "focal", label: "Focal", value: focal ?? "—"),
      Row(id: "coords", label: "Coords", value: coords),
      Row(id: "city", label: "City", value: "—"),
    ]
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
