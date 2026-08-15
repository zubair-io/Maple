// MapAnnotationContent.swift — visual content for a Map annotation (#2830).
//
// Two shapes, chosen by `MapAnnotationItem.Kind`: a circular thumbnail pin
// for a single-photo cell, a count bubble for everything else. Both are
// plain SwiftUI content views (no MapKit dependency) so the tvOS map
// (#2833) and the heatmap overlays (#2831/#2834) can adopt the same visual
// language even where they don't share this exact file (tvOS's ten-foot UI
// needs its own sizing/focus-effect pass).
//
// Phone sizing (#2878): both views read `\.mapleLayout` and shrink their
// diameters on `.phone`. The desktop metrics below were tuned for Mac/iPad's
// wider map viewport; reusing them verbatim on a phone's narrower viewport
// packs nearby pins/clusters closer together and increases overlap.

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

  @Environment(\.mapleLayout) private var layout
  @State private var decoded: CGImage?

  private var cacheKey: String { "\(host):\(thumbKey)" }

  /// 40pt on Mac/iPad (a mouse-precision target on a wide viewport); 32pt on
  /// phone, where the narrower viewport packs pins closer together (#2878).
  private var diameter: CGFloat { layout == .phone ? 32 : 40 }

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
            .font(.system(size: layout == .phone ? 10 : 12))
            .foregroundStyle(MapleTokens.textMuted)
        }
      }
      .frame(width: diameter, height: diameter)
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

  @Environment(\.mapleLayout) private var layout

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
  /// library-wide cell doesn't swallow the map. Phone gets a smaller scale
  /// (#2878) — same reasoning as `MapThumbnailPinView.diameter`. Returns
  /// constant literals directly (no intermediate array) — this re-evaluates
  /// on every annotation redraw during a pan/zoom, and a fresh `[CGFloat]`
  /// per evaluation is an avoidable allocation in that path.
  private var bubbleDiameter: CGFloat {
    switch (layout, count) {
    case (.phone, ..<10): return 26
    case (.phone, 10..<100): return 32
    case (.phone, 100..<1000): return 38
    case (.phone, _): return 44
    case (_, ..<10): return 32
    case (_, 10..<100): return 40
    case (_, 100..<1000): return 48
    case (_, _): return 56
    }
  }
}
