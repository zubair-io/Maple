// CameraLocationGrid.swift — S6 Info content, section 3.
//
// Two-column label/value grid for camera + location facts, rendered via
// MapleUI's `MuiLabelValueGrid` (Maple UI adoption epic #3019, wave MA3).
// Source-of-truth is the existing `ImageMetadataReader` EXIF scanner — its
// `ExifEntry` array exposes Make/Model/Lens/Aperture/Shutter/ISO/Focal/GPS
// rows keyed by stable section + label strings.
//
// We project that array into the spec's 8-field grid (Body / Lens /
// Aperture / Shutter / ISO / Focal / Coords / City), falling back to
// "—" for missing rows. Body folds Make + Model into one row because
// users read camera identity as "Hasselblad L3D-100c", not "Make:
// Hasselblad" plus a separate "Model" line.
//
// The "Path" row is the grid's one actionable field — MapleUI's grid
// gained `isLink`/`linkTapped` support in this PR specifically so this
// row could keep its "reveal in Finder" affordance without dropping out
// of the shared grid component for that one row.
//
// EXIF read is async (`CGImageSourceCreateWithURL` can hit disk and
// PhotoKit / Self-Hosted paths require an async `bytesProvider`). Same
// `.task(id: asset?.id)` pattern as the existing `DetailPanel.InfoTab`
// — load on asset change, stash in @State, cancel-on-switch via
// `task(id:)`'s built-in cancellation.
//
// City — spec mentions reverse-geocoding the GPS coords. We don't have
// a client-side reverse geocoder wired into MapleCore today; the
// existing Self-Hosted backend ships a `place` enrichment but it's
// surfaced through a different code path. v0.1 shows just the raw
// coords; reverse-geocoding the InfoPanel city is a follow-up.

import MapleCore
import MapleUI
import SwiftUI

// MARK: - CameraLocationGrid

struct CameraLocationGrid: View {
  let asset: AssetRef?
  /// Self-Hosted rich detail (City / Size), fetched once by `InfoPanelView`.
  /// `nil` for local / PhotoKit assets or before the fetch resolves.
  var enrichment: CloudEnrichmentSections?

  @Environment(\.revealFolderAction) private var revealFolder
  @Environment(\.dismiss) private var dismiss
  @State private var exif: [ImageMetadataReader.ExifEntry] = []

  private var rows: [InfoPanelVM.Row] {
    InfoPanelVM.cameraLocationRows(
      from: exif,
      city: enrichment?.city,
      fileSize: enrichment?.fileSize,
      // Search/local assets know their folder up front; cloud-browse assets
      // get it from the fetched detail's address (#2518).
      folder: asset?.displayFolder ?? enrichment?.folderDisplay
    )
  }

  /// The clickable "Path" row reveals the containing folder only when the
  /// asset actually has one (cloud catalog, or a local URL) and the action
  /// is present in the environment.
  private var canRevealFolder: Bool {
    guard revealFolder != nil, let asset else { return false }
    return asset.revealTarget != .none
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Camera & Location")
      MuiLabelValueGrid(
        rows: rows.map { row in
          MuiLabelValueRow(
            id: row.id,
            label: row.label,
            value: row.value,
            isLink: row.id == "folder" && canRevealFolder && row.value != "—"
          )
        },
        linkTapped: { _ in
          // Close the info sheet first so the user lands on the folder
          // grid (no-op for the inline mac/iPad inspector). Only the
          // "folder" row opts into `isLink`, so there's exactly one
          // possible tapped id.
          dismiss()
          if let asset { revealFolder?(asset) }
        }
      )
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-camera-location")
    .task(id: asset?.id) {
      await loadExif()
    }
  }

  private func loadExif() async {
    guard let asset else {
      exif = []
      return
    }
    let entries = await DetailPanelVM.loadExif(for: asset)
    // After the await the focused asset may have changed; only commit
    // if we're still the active asset.
    guard asset.id == self.asset?.id else { return }
    exif = entries
  }

  private func sectionHeader(_ title: String) -> some View {
    Text(title.uppercased())
      .font(MapleTokens.Typography.eyebrow)
      .foregroundStyle(MapleTokens.textMuted)
      .tracking(1.4)
  }
}

// MARK: - Previews

#Preview("CameraLocationGrid — empty (no asset)") {
  CameraLocationGrid(asset: nil)
    .frame(width: 300)
    .padding()
    .background(MapleTokens.bg)
}
