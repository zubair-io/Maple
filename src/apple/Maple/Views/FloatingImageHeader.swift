import SwiftUI

/// Shared leading content and glass treatment for Preview and Editor headers.
/// Screen-specific controls are supplied as trailing content so filename,
/// back affordance, spacing, and chrome cannot drift between the two surfaces.
struct FloatingImageHeader<Trailing: View>: View {
    let displayName: String
    let identifierPrefix: String
    let onBack: () -> Void
    @ViewBuilder let trailing: () -> Trailing

    @Environment(\.horizontalSizeClass) private var hSizeClass

    private var isCompact: Bool { hSizeClass == .compact }

    var body: some View {
        HStack(spacing: 10) {
            // Back chevron + filename are pinned outside the scroll region so
            // they stay visible however wide the trailing controls grow.
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ProTokens.text)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .accessibilityIdentifier("\(identifierPrefix)-back")

            Text(displayName)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(ProTokens.text)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: PreviewViewVM.filenameMaxWidth(isCompact: isCompact))
                .layoutPriority(1)
                .accessibilityIdentifier("\(identifierPrefix)-filename")

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
        .accessibilityIdentifier("\(identifierPrefix)-header")
    }
}
