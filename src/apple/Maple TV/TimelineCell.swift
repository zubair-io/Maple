// src/apple/Maple TV/TimelineCell.swift
import MapleCloudKit
import SwiftUI

/// One grid cell in the Timeline. A uniform `size`-square thumbnail
/// (crop-to-fill via `TVRemoteImage`); the focused cell scales up
/// (~1.09) with a red focus ring and reveals a caption below it
/// (filename, star rating, capture time, a green dot when an XMP sidecar
/// exists). Unfocused cells reserve the same caption space at zero
/// opacity, so every cell reports the same size to the enclosing
/// `LazyVGrid` and focusing a cell never reflows its neighbors
/// ("Uniform fixed-size cells", #2102).
struct TimelineCell: View {
  let asset: SearchAsset
  let server: URL
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  let identifier: String
  /// D6 (#2102) wires this to the full-screen viewer (current result set
  /// + selected index); D5 only needs a stable, already-wired seam so
  /// selection isn't a follow-up plumbing change.
  let onSelect: () -> Void

  static let size: CGFloat = 260

  var body: some View {
    Button(action: onSelect) {
      TimelineCellCard(asset: asset, server: server, thumbClient: thumbClient, thumbCache: thumbCache)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(identifier)
    .accessibilityLabel(Self.accessibilityLabel(for: asset))
  }

  private static func accessibilityLabel(for asset: SearchAsset) -> String {
    var parts = [asset.filename]
    if let rating = asset.rating, rating > 0 {
      parts.append(rating == 1 ? "1 star" : "\(rating) stars")
    }
    if asset.has_xmp == true {
      parts.append("edited")
    }
    return parts.joined(separator: ", ")
  }
}

/// The focus-reactive visual content of a cell, split out so it can read
/// `\.isFocused` — that environment key reflects the focus state of the
/// nearest focusable ancestor (the enclosing `Button`), which is only
/// meaningful for a descendant view, not the button itself.
private struct TimelineCellCard: View {
  let asset: SearchAsset
  let server: URL
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache

  @Environment(\.isFocused) private var isFocused

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      TVRemoteImage(
        server: server,
        absPath: asset.abs_path,
        kind: .thumb(size: 512),
        thumbClient: thumbClient,
        thumbCache: thumbCache,
        contentMode: .fill,
        accessibilityLabel: asset.filename
      )
      .frame(width: TimelineCell.size, height: TimelineCell.size)
      .clipShape(RoundedRectangle(cornerRadius: 12))
      .overlay(
        RoundedRectangle(cornerRadius: 12)
          .stroke(MapleTVTheme.primary, lineWidth: isFocused ? 4 : 0)
      )
      .scaleEffect(isFocused ? 1.09 : 1.0)
      .animation(.easeOut(duration: 0.2), value: isFocused)

      caption
        .opacity(isFocused ? 1 : 0)
    }
    .frame(width: TimelineCell.size, alignment: .leading)
  }

  @ViewBuilder
  private var caption: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(asset.filename)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(MapleTVTheme.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)

      HStack(spacing: 6) {
        if let rating = asset.rating, rating > 0 {
          HStack(spacing: 1) {
            ForEach(0..<rating, id: \.self) { _ in
              Image(systemName: "star.fill")
                .font(.system(size: 9))
                .foregroundStyle(MapleTVTheme.star)
            }
          }
        }
        if let timeText = Self.captureTimeText(asset.captured_at) {
          Text(timeText)
            .font(.system(size: 11))
            .foregroundStyle(MapleTVTheme.textMuted)
        }
        if asset.has_xmp == true {
          Circle()
            .fill(Color.green)
            .frame(width: 6, height: 6)
            .accessibilityHidden(true)
        }
      }
    }
    .fixedSize(horizontal: false, vertical: true)
  }

  private static func captureTimeText(_ isoString: String?) -> String? {
    guard let isoString, let date = parseTimelineISO8601(isoString) else { return nil }
    return date.formatted(date: .omitted, time: .shortened)
  }
}

#Preview {
  ZStack {
    MapleTVTheme.background.ignoresSafeArea()
    TimelineCell(
      asset: SearchAsset(
        id: "1", folder_id: "f", abs_path: "/tmp/preview.dng", filename: "IMG_0001.DNG",
        captured_at: "2026-07-18T14:32:00Z", rating: 4, has_xmp: true
      ),
      server: URL(string: "https://preview.maple.invalid")!,
      thumbClient: .preview(),
      thumbCache: .preview(),
      identifier: "timeline-cell-preview",
      onSelect: {}
    )
    .padding(60)
  }
  .preferredColorScheme(.dark)
}
