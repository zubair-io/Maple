// MuiRatingFlags.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.2). Star rating plus a pick/reject flag, built from Icon + Badge.
// Mirrors the classic Lightroom culling pattern: click a star to set the
// rating (click the current top star again to clear it); the flag cycles
// none → pick → reject → none.

import SwiftUI

public enum MuiRatingFlagState: Sendable {
    case none, pick, reject

    var next: MuiRatingFlagState {
        switch self {
        case .none: return .pick
        case .pick: return .reject
        case .reject: return .none
        }
    }
}

public struct MuiRatingFlags: View {
    @Binding public var rating: Int
    public let max: Int
    @Binding public var flag: MuiRatingFlagState
    public let disabled: Bool

    public init(
        rating: Binding<Int>,
        max: Int = 5,
        flag: Binding<MuiRatingFlagState> = .constant(.none),
        disabled: Bool = false
    ) {
        self._rating = rating
        self.max = max
        self._flag = flag
        self.disabled = disabled
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingXs) {
            HStack(spacing: 2) {
                ForEach(1...Swift.max(1, max), id: \.self) { star in
                    Button {
                        setRating(star)
                    } label: {
                        MuiIcon(
                            name: star <= rating ? "star.fill" : "star",
                            size: .sm,
                            color: star <= rating ? MuiTokens.star : MuiTokens.border
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(star) star\(star > 1 ? "s" : "")")
                }
            }
            .disabled(disabled)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Rating")
            .accessibilityValue("\(rating) of \(max) stars")

            if rating > 0 {
                MuiBadge(variant: .rating, value: "\(rating)", label: "\(rating) out of \(max) stars")
            }

            Button {
                guard !disabled else { return }
                flag = flag.next
            } label: {
                MuiIcon(name: "flag.fill", size: .sm, color: flagColor)
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .accessibilityLabel("Flag: \(flagAccessibilityValue)")
            .accessibilityAddTraits(flag == .none ? .isButton : [.isButton, .isSelected])
        }
        .opacity(disabled ? 0.45 : 1)
    }

    private func setRating(_ star: Int) {
        guard !disabled else { return }
        rating = Self.nextRating(current: rating, tapped: star)
    }

    private var flagColor: Color {
        switch flag {
        case .none: return MuiTokens.textMuted
        case .pick: return MuiTokens.successText
        case .reject: return MuiTokens.errorText
        }
    }

    private var flagAccessibilityValue: String {
        switch flag {
        case .none: return "None"
        case .pick: return "Pick"
        case .reject: return "Reject"
        }
    }

    /// The rating after tapping star `tapped` — clears to `tapped - 1` when
    /// `tapped` is already the current rating (tap-the-top-star-again
    /// clears), otherwise sets to `tapped`. Public + static so this is
    /// unit-testable without rendering a view.
    public static func nextRating(current: Int, tapped: Int) -> Int {
        tapped == current ? tapped - 1 : tapped
    }
}

#Preview("MuiRatingFlags") {
    struct Demo: View {
        @State private var rating = 3
        @State private var flag: MuiRatingFlagState = .pick

        var body: some View {
            VStack(alignment: .leading, spacing: 16) {
                MuiRatingFlags(rating: $rating, flag: $flag)
                MuiRatingFlags(rating: .constant(0), flag: .constant(.none))
                MuiRatingFlags(rating: .constant(5), flag: .constant(.reject), disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
