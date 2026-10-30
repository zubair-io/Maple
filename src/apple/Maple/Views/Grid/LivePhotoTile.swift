import MapleCore
import SwiftUI

/// The text pills stacked in a tile's top-leading corner: HIDDEN and the Live Photo badge.
struct GridCornerBadges: View {
  let overlays: GridCellOverlays

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if overlays.hidden { GridBadgePill(text: "HIDDEN") }
      if overlays.livePhoto != nil {
        GridBadgePill(text: "LIVE").accessibilityLabel("Live Photo")
      }
    }
  }
}

private struct GridBadgePill: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(size: 9, weight: .bold))
      .foregroundStyle(.white)
      .padding(.horizontal, 6)
      .padding(.vertical, 3)
      .background(Color.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 3))
      .padding(6)
  }
}

/// Play affordance for the clip half of a Live Photo pair. It sits beside the
/// tile's own tap target, so pressing it never opens Full image, and the
/// player exists only while the clip is playing.
struct LivePhotoClipOverlay: View {
  let item: PhotoGridItem

  @State private var isPlaying = false

  var body: some View {
    if item.overlays.livePhoto == .clip, let clip = clipSource {
      ZStack {
        if isPlaying {
          MotionClipPlayerView(
            resolveURL: { try? await clip.cloud.videoURL(for: clip.refID) },
            isInline: true,
            onFinished: { isPlaying = false }
          )
          .allowsHitTesting(false)
        }
        Button {
          isPlaying.toggle()
        } label: {
          Image(systemName: isPlaying ? "stop.fill" : "play.fill")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 32, height: 32)
            .background(Color.black.opacity(0.55), in: Circle())
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isPlaying ? "Stop Live Photo clip" : "Play Live Photo clip")
        .accessibilityIdentifier("grid-live-play-\(item.displayName)")
      }
      .onDisappear { isPlaying = false }
    }
  }

  private var clipSource: (cloud: CloudSource, refID: String)? {
    guard case .local(let ref, let box) = item.thumbnailSource,
      let cloud = box?.source as? CloudSource, let refID = ref.stableID
    else { return nil }
    return (cloud, refID)
  }
}
