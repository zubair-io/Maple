// src/apple/Maple TV/TVMapAnnotationView.swift
//
// Ten-foot-UI visuals for one map annotation (#2833) — a thumbnail pin for
// a `count == 1` cell, a count bubble otherwise, per `MapAnnotationItem.Kind`.
// Deliberately its own view rather than reusing macOS/iOS's
// `MapThumbnailPinView` / `MapClusterBubbleView` (`Maple/Views/Map/
// MapAnnotationContent.swift`): those live in the app target (which this
// target can't import) AND the design doc calls out that tvOS's ten-foot
// sizing/focus-effect pass is its own visual language, not a shared file —
// same split `TimelineCell` already makes from the touch platforms' grid
// cells.
import MapleCloudKit
import SwiftUI

/// One focusable pin/cluster `Button`. Selecting it fires `onSelect` — no
/// hit-testing anywhere, matching "pins are focusable items, not tap
/// targets" (the design doc's tvOS section): the focus engine moves
/// remote-directional focus onto this button the same way it does onto any
/// other focusable sibling, purely from on-screen geometry.
struct TVMapAnnotationButton: View {
  let item: MapAnnotationItem
  let server: URL
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  /// Set on exactly one button per fetch — the first pin in
  /// `TVMapFocusOrder.ordered(_:)` — so a fresh screen (or a region change
  /// that reveals pins for the first time) has a deterministic default
  /// focus target instead of whichever pin the platform happens to pick.
  let isDefaultFocusTarget: Bool
  let focusNamespace: Namespace.ID
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      TVMapAnnotationContent(item: item, server: server, thumbClient: thumbClient, thumbCache: thumbCache)
    }
    .buttonStyle(.plain)
    // Own fill/ring/scale is the focus indication (see
    // `TVMapAnnotationContent`) — suppress tvOS's default halo, same
    // convention as `MenuRow`/`TimelineCell`.
    .focusEffectDisabled()
    .prefersDefaultFocus(isDefaultFocusTarget, in: focusNamespace)
    .accessibilityLabel(Self.accessibilityLabel(for: item))
    .accessibilityIdentifier(Self.accessibilityIdentifier(for: item))
  }

  private static func accessibilityLabel(for item: MapAnnotationItem) -> String {
    switch item.kind {
    case .thumbnail:
      return "Open search for this photo's location"
    case .cluster(let count):
      return count == 1
        ? "Open search for this photo's location"
        : "Open search for \(count) photos in this area"
    }
  }

  private static func accessibilityIdentifier(for item: MapAnnotationItem) -> String {
    switch item.kind {
    case .thumbnail: return "tv-map-pin-thumbnail-\(item.id)"
    case .cluster: return "tv-map-pin-cluster-\(item.id)"
    }
  }
}

/// The focus-reactive visual content, split out so it can read
/// `\.isFocused` — that environment key reflects the nearest focusable
/// ANCESTOR's focus state, so it's only meaningful read from a descendant
/// of the enclosing `Button`, not the button itself (same split
/// `TimelineCellCard`/`MenuRowCard` use).
private struct TVMapAnnotationContent: View {
  let item: MapAnnotationItem
  let server: URL
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache

  @Environment(\.isFocused) private var isFocused

  /// Ten-foot sizing: noticeably larger than macOS/iOS's 40pt thumbnail pin
  /// — legible and easy to spot from a couch, and a comfortable focus-ring
  /// target for the Siri Remote's coarse directional stepping.
  private static let thumbnailDiameter: CGFloat = 108
  private static let ringWidth: CGFloat = 6

  var body: some View {
    Group {
      switch item.kind {
      case .thumbnail(_, let thumbKey):
        thumbnailPin(thumbKey: thumbKey)
      case .cluster(let count):
        clusterBubble(count: count)
      }
    }
    .scaleEffect(isFocused ? 1.15 : 1.0)
    .animation(.easeOut(duration: 0.15), value: isFocused)
  }

  private func thumbnailPin(thumbKey: String) -> some View {
    Circle()
      .fill(MapleTVTheme.surface)
      .overlay {
        TVRemoteImage(
          server: server,
          absPath: thumbKey,
          kind: .thumb,
          thumbClient: thumbClient,
          thumbCache: thumbCache,
          contentMode: .fill,
          accessibilityLabel: "Photo pin"
        )
        .clipShape(Circle())
      }
      .frame(width: Self.thumbnailDiameter, height: Self.thumbnailDiameter)
      .overlay(
        Circle().strokeBorder(isFocused ? MapleTVTheme.primary : .white,
                              lineWidth: isFocused ? Self.ringWidth : 3)
      )
      .shadow(color: .black.opacity(0.35), radius: 8, y: 3)
  }

  private func clusterBubble(count: Int) -> some View {
    let diameter = Self.bubbleDiameter(for: count)
    return Circle()
      .fill(isFocused ? MapleTVTheme.primary : MapleTVTheme.surface)
      .frame(width: diameter, height: diameter)
      .overlay(
        Text(Self.label(for: count))
          .font(.system(size: diameter * 0.32, weight: .bold))
          .foregroundStyle(.white)
          .minimumScaleFactor(0.6)
          .lineLimit(1)
      )
      .overlay(Circle().strokeBorder(.white, lineWidth: 3))
      .shadow(color: .black.opacity(0.35), radius: 8, y: 3)
  }

  /// Bigger bubbles for bigger clusters — mirrors the touch platforms'
  /// `MapClusterBubbleView`, scaled up for the ten-foot UI.
  private static func bubbleDiameter(for count: Int) -> CGFloat {
    switch count {
    case ..<10: return 72
    case 10..<100: return 92
    case 100..<1000: return 112
    default: return 132
    }
  }

  /// Integer division would round a cluster of 1999 down to "1k" —
  /// format with one decimal so it reads "2.0k".
  private static func label(for count: Int) -> String {
    guard count >= 1000 else { return "\(count)" }
    return String(format: "%.1fk", Double(count) / 1000)
  }
}
