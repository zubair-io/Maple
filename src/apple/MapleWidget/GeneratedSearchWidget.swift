// GeneratedSearchWidget.swift
//
// The widget itself: a photo from one of the day's generated collections,
// captioned with the collection's title.
//
// Sizes earn their content rather than scaling one layout: small is the photo
// plus a single line, medium adds the subtitle, large gives the caption room
// to breathe. Text always sits on a scrim over the image so a bright photo
// can't render it unreadable.

import SwiftUI
import WidgetKit

struct GeneratedSearchWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: GeneratedSearchEntry

  var body: some View {
    caption
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
      // The photo AND the caption's scrim live in the container BACKGROUND:
      // backgrounds render edge-to-edge (and under the system margins),
      // where content-layer views get the inset content size — the photo
      // used to letterbox and the scrim floated as an inset box for the
      // same reason. Only the caption TEXT stays in the content layer,
      // where the margins are exactly what it wants.
      .containerBackground(for: .widget) {
        ZStack(alignment: .bottom) {
          photo
          scrim
        }
      }
      .widgetURL(deepLink)
  }

  @ViewBuilder
  private var photo: some View {
    if let data = entry.imageData, let image = PlatformImage(data: data) {
      GeometryReader { proxy in
        Image(platformImage: image)
          .resizable()
          .scaledToFill()
          .frame(width: proxy.size.width, height: proxy.size.height)
          .clipped()
      }
    } else {
      // No photo yet: sign-in pending, first run before the worker has
      // produced anything, or an unreachable server. A calm gradient reads
      // as "nothing to show" rather than as breakage.
      LinearGradient(
        colors: [Color(white: 0.18), Color(white: 0.08)],
        startPoint: .top,
        endPoint: .bottom
      )
    }
  }

  private var caption: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(entry.title)
        .font(family == .systemSmall ? .caption.bold() : .headline)
        .lineLimit(family == .systemSmall ? 2 : 1)
      if family != .systemSmall, let subtitle = entry.subtitle {
        Text(subtitle)
          .font(.caption)
          .opacity(0.85)
          .lineLimit(1)
      }
    }
    .foregroundStyle(.white)
    .padding(.bottom, family == .systemSmall ? 4 : 6)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Bottom-anchored legibility gradient, rendered in the background layer so
  /// it bleeds to the tile's edges instead of floating as an inset box.
  private var scrim: some View {
    LinearGradient(
      colors: [.black.opacity(0.0), .black.opacity(0.7)],
      startPoint: .top,
      endPoint: .bottom
    )
    .frame(height: family == .systemSmall ? 70 : 96)
  }

  /// Opens the app's search UI seeded with this collection's query — the
  /// `search` host now exists in `DeepLinkParser` and routes through
  /// `AppShell.navigateToSearch`. The empty state opens the app plainly.
  private var deepLink: URL? {
    entry.deepLink ?? URL(string: "maple://")
  }
}

struct GeneratedSearchWidget: Widget {
  private let kind = "MapleGeneratedSearchWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: GeneratedSearchProvider()) { entry in
      GeneratedSearchWidgetView(entry: entry)
    }
    .configurationDisplayName("Rediscover")
    .description("A photo from one of today's collections.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}
