import MapleCore
import MapleUI
import SwiftUI

/// Shared leading content and glass treatment for Preview and Editor headers.
/// Screen-specific controls are supplied as trailing content so filename,
/// back affordance, spacing, and chrome cannot drift between the two surfaces.
struct FloatingImageHeader<Trailing: View>: View {
  let displayName: String
  let identifierPrefix: String
  let onBack: () -> Void
  @ViewBuilder let trailing: () -> Trailing

  @Environment(\.mapleLayout) private var layout
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  private var isCompact: Bool {
    #if os(iOS)
      horizontalSizeClass != .regular
    #else
      layout == .phone
    #endif
  }

  var body: some View {
    HStack(spacing: 10) {
      // Keep the back affordance outside the scroll region. The filename is
      // centered independently below, while trailing controls remain scrollable.
      Button(action: onBack) {
        MuiIcon(name: "chevron_left", size: .sm)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ProTokens.text)
          .frame(minWidth: 44, minHeight: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Back")
      .accessibilityIdentifier("\(identifierPrefix)-back")
      .contentShape(Rectangle())

      if !isCompact {
        Text(displayName)
          .font(MapleTokens.Typography.filename)
          .foregroundStyle(ProTokens.text)
          .lineLimit(1)
          .truncationMode(.middle)
          .frame(maxWidth: PreviewViewVM.filenameMaxWidth(isCompact: false))
          .layoutPriority(1)
          .accessibilityIdentifier("\(identifierPrefix)-filename")
      }

      if isCompact {
        // On a phone the pill spans the screen width; the trailing
        // controls scroll horizontally rather than pushing the pill
        // past the screen edges and clipping the back button / zoom.
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 10) { trailing() }
        }
      } else {
        trailing()
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 44)
    .contentShape(Capsule())
    .overlay {
      if isCompact {
        Text(displayName)
          .font(MapleTokens.Typography.filename)
          .foregroundStyle(ProTokens.text)
          .lineLimit(1)
          .truncationMode(.middle)
          .frame(maxWidth: PreviewViewVM.filenameMaxWidth(isCompact: true))
          .allowsHitTesting(false)
          .accessibilityIdentifier("\(identifierPrefix)-filename")
      }
    }
    // Compact: stretch to the offered width so the trailing ScrollView is
    // bounded (and can scroll). Regular: size to intrinsic content width.
    .frame(maxWidth: isCompact ? .infinity : nil)
    .fixedSize(horizontal: !isCompact, vertical: false)
    .background(.ultraThinMaterial, in: Capsule())
    .overlay(Capsule().stroke(ProTokens.border, lineWidth: 0.5))
    .shadow(color: .black.opacity(0.24), radius: 12, y: 4)
    // Win the offered width over the centering Spacers on compact so the
    // pill fills the row instead of splitting it three ways.
    .layoutPriority(isCompact ? 1 : 0)
    .padding(.horizontal, isCompact ? 12 : 0)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("\(identifierPrefix)-header")
  }
}
