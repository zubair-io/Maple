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

    var body: some View {
        HStack(spacing: 10) {
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
                .frame(maxWidth: PreviewViewVM.filenameMaxWidth(isCompact: hSizeClass == .compact))
                .layoutPriority(1)
                .accessibilityIdentifier("\(identifierPrefix)-filename")

            trailing()
        }
        .padding(.horizontal, 10)
        .frame(height: 44)
        .fixedSize(horizontal: true, vertical: false)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(ProTokens.border, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.24), radius: 12, y: 4)
        .accessibilityIdentifier("\(identifierPrefix)-header")
    }
}

