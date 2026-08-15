// MapAnnotationContent.swift — visual content for a Map annotation (#2830).
//
// Two shapes, chosen by `MapAnnotationItem.Kind`: a circular thumbnail pin
// for a single-photo cell, a count bubble for everything else. Both are
// plain SwiftUI content views (no MapKit dependency) so the tvOS map
// (#2833) and the heatmap overlays (#2831/#2834) can adopt the same visual
// language even where they don't share this exact file (tvOS's ten-foot UI
// needs its own sizing/focus-effect pass).

import SwiftUI
import Foundation
import MapleCore

/// Circular thumbnail pin for a `count == 1` cell. Fetches its bytes via
/// the shared `fetchCloudThumbBytes` (cache-first, then the network
/// client), decoded off-main via `ThumbnailDecoder`.
struct MapThumbnailPinView: View {
  let assetID: String
  let thumbKey: String
  let host: String
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  let isSelected: Bool

  @State private var decoded: CGImage?

  private var cacheKey: String { "\(host):\(thumbKey)" }

  var body: some View {
    Circle()
      .fill(MapleTokens.surfaceAlt)
      .overlay {
        if let decoded {
          Image(decorative: decoded, scale: 1)
            .resizable()
            .aspectRatio(contentMode: .fill)
            .clipShape(Circle())
        } else {
          Image(systemName: "photo")
            .font(.system(size: 12))
            .foregroundStyle(MapleTokens.textMuted)
        }
      }
      .frame(width: 40, height: 40)
      .overlay(
        Circle().strokeBorder(isSelected ? MapleTokens.primary : Color.white, lineWidth: isSelected ? 3 : 2)
      )
      .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
      .task(id: cacheKey) {
        let bytes = await fetchCloudThumbBytes(host: host, absPath: thumbKey, cache: thumbCache, client: thumbClient)
        guard !Task.isCancelled else { return }
        let image = await ThumbnailDecoder.image(for: bytes, key: cacheKey)
        guard !Task.isCancelled else { return }
        decoded = image
      }
      .accessibilityLabel("Photo pin")
      .accessibilityIdentifier("map-pin-thumbnail-\(assetID)")
  }
}

/// Count bubble for a multi-photo cell.
struct MapClusterBubbleView: View {
  let count: Int
  let isSelected: Bool

  /// Integer division would round a cluster of 1999 down to "1k" — format
  /// with one decimal instead so it reads "2.0k".
  private var label: String {
    guard count >= 1000 else { return "\(count)" }
    return String(format: "%.1fk", Double(count) / 1000)
  }

  var body: some View {
    Circle()
      .fill(isSelected ? MapleTokens.primary : MapleTokens.primaryDim)
      .frame(width: bubbleDiameter, height: bubbleDiameter)
      .overlay(
        Text(label)
          .font(MapleTokens.Typography.chipLabel)
          .foregroundStyle(.white)
      )
      .overlay(Circle().strokeBorder(Color.white, lineWidth: 2))
      .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
      .accessibilityLabel("\(count) photos")
      .accessibilityIdentifier("map-pin-cluster-\(count)")
  }

  /// Bigger bubbles for bigger clusters, clamped to a sane range so a
  /// library-wide cell doesn't swallow the map.
  private var bubbleDiameter: CGFloat {
    switch count {
    case ..<10: return 32
    case 10..<100: return 40
    case 100..<1000: return 48
    default: return 56
    }
  }
}
