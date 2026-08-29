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
    /// Non-interactive presentation mode (mirrors the web `readonly` mode
    /// on `mui-rating-flags`, split there into a `MuiRatingFlagsDisplay`
    /// sub-component to clear a template-complexity gate that has no Swift
    /// equivalent). No buttons, no tap targets, full opacity regardless of
    /// `disabled` — exists so a caller can nest this inside its own tap
    /// target (e.g. a grid-cell thumbnail button) without creating an
    /// invalid nested-interactive control. Renders a PICK/REJECT text chip
    /// only when `flag` is set, and a static star row only when
    /// `rating > 0` — an unrated, unflagged item renders nothing.
    public let readonly: Bool

    public init(
        rating: Binding<Int>,
        max: Int = 5,
        flag: Binding<MuiRatingFlagState> = .constant(.none),
        disabled: Bool = false,
        readonly: Bool = false
    ) {
        self._rating = rating
        self.max = max
        self._flag = flag
        self.disabled = disabled
        self.readonly = readonly
    }

    public var body: some View {
        if readonly {
            // Truly render nothing (no focusable element, no accessibility
            // label) when there is no state to show.
            if rating > 0 || flag != .none {
                readonlyBody
            }
        } else {
            interactiveBody
        }
    }

    @ViewBuilder
    private var readonlyBody: some View {
        HStack(spacing: MuiTokens.spacingXs) {
            if flag != .none {
                Text(flag == .pick ? "PICK" : "REJECT")
                    .font(MuiTokens.TypeScale.font(.chipLabel))
                    .foregroundStyle(flagColor)
            }
            if rating > 0 {
                HStack(spacing: 1) {
                    ForEach(1...Swift.max(1, max), id: \.self) { star in
                        MuiIcon(
                            name: star <= rating ? "star.fill" : "star",
                            size: .xs,
                            color: star <= rating ? MuiTokens.star : MuiTokens.textMuted
                        )
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.readonlyAccessibilityLabel(rating: rating, max: max, flag: flag))
    }

    /// The announced label for the read-only presentation — empty when
    /// there's nothing rated or flagged, otherwise combines whichever of
    /// the two is set. Public + static so this is unit-testable without
    /// rendering a view.
    public static func readonlyAccessibilityLabel(rating: Int, max: Int, flag: MuiRatingFlagState) -> String {
        var parts: [String] = []
        if rating > 0 { parts.append("\(rating) of \(max) stars") }
        switch flag {
        case .none: break
        case .pick: parts.append("Pick")
        case .reject: parts.append("Reject")
        }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private var interactiveBody: some View {
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

#Preview("MuiRatingFlags — readonly") {
    VStack(alignment: .leading, spacing: 12) {
        MuiRatingFlags(rating: .constant(3), flag: .constant(.pick), readonly: true)
        MuiRatingFlags(rating: .constant(0), flag: .constant(.reject), readonly: true)
        MuiRatingFlags(rating: .constant(5), flag: .constant(.none), readonly: true)
        MuiRatingFlags(rating: .constant(0), flag: .constant(.none), readonly: true)
    }
    .padding()
    .background(MuiTokens.bg)
}
