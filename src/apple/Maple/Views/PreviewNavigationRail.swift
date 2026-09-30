// Preview-only navigation rail. The editor's tool rail stays independent:
// Preview switches between thumbnails and a named photo list without adding
// a second action toolbar or entering Browse selection mode.

import MapleCore
import MapleUI
import SwiftUI

struct PreviewNavigationRail: View {
  let assets: [AssetRef]
  let activeID: AssetRef.ID?
  let source: (any ImageSource)?

  @Binding var showsList: Bool
  @Binding var thumbnailPosition: AssetRef.ID?
  @Binding var listPosition: AssetRef.ID?
  let onSelect: (AssetRef) -> Void

  private var railWidth: CGFloat { showsList ? 224 : 106 }

  var body: some View {
    VStack(spacing: 6) {
      Button {
        showsList.toggle()
      } label: {
        Label {
          Text(showsList ? "Filmstrip" : "Photo list")
        } icon: {
          MuiIcon(name: showsList ? "film" : "list.bullet", size: .sm)
        }
        .font(.caption.weight(.semibold))
        .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.plain)
      .foregroundStyle(ProTokens.text)
      .accessibilityLabel(showsList ? "Show filmstrip" : "Show photo list")
      .accessibilityValue(showsList ? "Photo list shown" : "Filmstrip shown")
      .accessibilityIdentifier("preview-navigation-toggle")

      if showsList {
        ScrollView(.vertical) {
          LazyVStack(spacing: 2) {
            ForEach(assets, id: \.id) { item in
              row(for: item)
                .id(item.id)
            }
          }
          .scrollTargetLayout()
        }
        .scrollPosition(id: $listPosition)
        .accessibilityIdentifier("preview-photo-list")
      } else {
        ScrollView(.vertical) {
          LazyVStack(spacing: 6) {
            ForEach(assets, id: \.id) { item in
              thumbnail(for: item)
                .id(item.id)
            }
          }
          .scrollTargetLayout()
        }
        .scrollPosition(id: $thumbnailPosition)
        .accessibilityIdentifier("preview-filmstrip-rail")
      }
    }
    .padding(6)
    .frame(width: railWidth)
    .frame(maxHeight: 480)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(ProTokens.border, lineWidth: 0.5))
    .onAppear {
      if thumbnailPosition == nil { thumbnailPosition = activeID }
      if listPosition == nil { listPosition = activeID }
    }
    .onChange(of: activeID) { _, newID in
      thumbnailPosition = newID
      listPosition = newID
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("preview-navigation-rail")
  }

  private func thumbnail(for item: AssetRef) -> some View {
    Button {
      onSelect(item)
    } label: {
      photo(item, width: 90, height: 60)
        .overlay {
          RoundedRectangle(cornerRadius: 6)
            .strokeBorder(item.id == activeID ? ProTokens.accent : .clear, lineWidth: 2)
        }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(item.displayName)
    .accessibilityAddTraits(item.id == activeID ? .isSelected : [])
  }

  private func row(for item: AssetRef) -> some View {
    Button {
      onSelect(item)
    } label: {
      HStack(spacing: 8) {
        photo(item, width: 56, height: 44)
        Text(item.displayName)
          .font(.caption)
          .lineLimit(2)
          .truncationMode(.middle)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .foregroundStyle(ProTokens.text)
      .padding(4)
      .frame(minHeight: 52)
      .background(
        item.id == activeID ? ProTokens.accent.opacity(0.2) : .clear,
        in: RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(item.displayName)
    .accessibilityAddTraits(item.id == activeID ? .isSelected : [])
  }

  private func photo(_ item: AssetRef, width: CGFloat, height: CGFloat) -> some View {
    AsyncThumbnail(asset: item, source: source) { decoded in
      ZStack {
        RoundedRectangle(cornerRadius: 6).fill(ProTokens.panel)
        if let decoded {
          Image(decorative: decoded, scale: 1)
            .resizable()
            .aspectRatio(contentMode: .fill)
        }
      }
      .frame(width: width, height: height)
      .clipShape(RoundedRectangle(cornerRadius: 6))
    }
  }
}
