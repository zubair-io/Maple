// CameraLocationGrid.swift — S6 Info content, section 3.
//
// Two-column label/value grid for camera + location facts. Source-of-truth
// is the existing `ImageMetadataReader` EXIF scanner — its `ExifEntry`
// array exposes Make/Model/Lens/Aperture/Shutter/ISO/Focal/GPS rows
// keyed by stable section + label strings.
//
// We project that array into the spec's 8-field grid (Body / Lens /
// Aperture / Shutter / ISO / Focal / Coords / City), falling back to
// "—" for missing rows. Body folds Make + Model into one row because
// users read camera identity as "Hasselblad L3D-100c", not "Make:
// Hasselblad" plus a separate "Model" line.
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
import SwiftUI

// MARK: - CameraLocationGrid

struct CameraLocationGrid: View {
  let asset: AssetRef?
  /// Self-Hosted rich detail (City / Size), fetched once by `InfoPanelView`.
  /// `nil` for local / PhotoKit assets or before the fetch resolves.
  var enrichment: CloudEnrichmentSections?

  @Environment(\.revealFolderAction) private var revealFolder
  @State private var exif: [ImageMetadataReader.ExifEntry] = []

  private var rows: [InfoPanelVM.Row] {
    InfoPanelVM.cameraLocationRows(
      from: exif,
      city: enrichment?.city,
      fileSize: enrichment?.fileSize,
      path: asset?.displayPath
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
    let rows = rows
    return VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Camera & Location")
      VStack(spacing: 0) {
        ForEach(rows) { row in
          if row.id == "path", canRevealFolder, row.value != "—" {
            KVRow(label: row.label, value: row.value, onTap: {
              if let asset { revealFolder?(asset) }
            })
          } else {
            KVRow(label: row.label, value: row.value)
          }
          if row.id != rows.last?.id {
            Rectangle()
              .fill(MapleTokens.border)
              .frame(height: 0.5)
          }
        }
      }
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

// MARK: - KVRow

struct KVRow: View {
  let label: String
  let value: String
  /// When set, the value renders as a tappable link (accent color) that runs
  /// this action — used by the "Path" row to open the containing folder.
  var onTap: (() -> Void)? = nil

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Text(label)
        .font(MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMuted)
        .frame(width: 72, alignment: .leading)
      if let onTap {
        Button(action: onTap) {
          Text(value)
            .font(MapleTokens.Typography.valueChip)
            .foregroundStyle(MapleTokens.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .lineLimit(2)
            .truncationMode(.middle)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the containing folder")
        .accessibilityIdentifier("info-path-reveal")
      } else {
        Text(value)
          .font(MapleTokens.Typography.valueChip)
          .monospacedDigit()
          .foregroundStyle(MapleTokens.textMain)
          .frame(maxWidth: .infinity, alignment: .leading)
          .lineLimit(2)
          .textSelection(.enabled)
      }
    }
    .padding(.vertical, 7)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Previews

#Preview("CameraLocationGrid — empty (no asset)") {
  CameraLocationGrid(asset: nil)
    .frame(width: 300)
    .padding()
    .background(MapleTokens.bg)
}
