import MapleCore
import SwiftUI

/// Separate native glass surfaces keep navigation, context, and actions legible.
/// The center yields width before either 44-point action group can be clipped.
struct FloatingImageHeader<Center: View, Trailing: View>: View {
  let identifierPrefix: String
  let onBack: () -> Void
  @ViewBuilder let center: () -> Center
  @ViewBuilder let trailing: () -> Trailing

  var body: some View {
    glassContainer
      .frame(maxWidth: 600)
      .padding(.horizontal, 20)
      .layoutPriority(1)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("\(identifierPrefix)-header")
  }

  @ViewBuilder private var glassContainer: some View {
    if #available(iOS 26.0, macOS 26.0, *) {
      GlassEffectContainer(spacing: 12) { controls }
    } else {
      controls
    }
  }

  private var controls: some View {
    HStack(spacing: 12) {
      Button(action: onBack) {
        Image(systemName: "chevron.left")
          .font(.system(size: 22, weight: .medium))
          .frame(width: 44, height: 44)
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .modifier(PhotoHeaderGlass())
      .accessibilityLabel("Back")
      .accessibilityIdentifier("\(identifierPrefix)-back")
      .fixedSize()

      center()
        .frame(maxWidth: .infinity)
        .frame(height: 44)
        .modifier(PhotoHeaderGlass())

      HStack(spacing: 8) { trailing() }
        .padding(.horizontal, 4)
        .frame(height: 44)
        .modifier(PhotoHeaderGlass())
        .fixedSize()
    }
    .foregroundStyle(ProTokens.text)
  }
}

/// System Liquid Glass follows accessibility settings; older OSes use material.
private struct PhotoHeaderGlass: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26.0, macOS 26.0, *) {
      content.glassEffect(.regular, in: .capsule)
    } else {
      content
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(ProTokens.border, lineWidth: 0.5))
    }
  }
}
