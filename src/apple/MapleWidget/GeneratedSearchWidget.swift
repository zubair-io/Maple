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
    ZStack(alignment: .bottomLeading) {
      photo
      caption
    }
    .containerBackground(for: .widget) { Color.black }
    .widgetURL(deepLink)
  }

  @ViewBuilder
  private var photo: some View {
    if let data = entry.imageData, let image = PlatformImage(data: data) {
      Image(platformImage: image)
        .resizable()
        .aspectRatio(contentMode: .fill)
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
    .padding(family == .systemSmall ? 10 : 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      // Scrim, not a flat bar: keeps the photo visible while guaranteeing
      // legible text over a blown-out sky.
      LinearGradient(
        colors: [.black.opacity(0.0), .black.opacity(0.75)],
        startPoint: .top,
        endPoint: .bottom
      )
    )
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
