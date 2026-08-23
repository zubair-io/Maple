// MuiSuggestionPreview.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Proposed change with accept/reject, built from Text,
// Button.

import SwiftUI

public enum MuiSuggestionResolution: Sendable {
    case accepted, rejected
}

public struct MuiSuggestionPreview: View {
    public let description: String
    public let resolved: MuiSuggestionResolution?
    public let accepted: (() -> Void)?
    public let rejected: (() -> Void)?

    public init(
        description: String,
        resolved: MuiSuggestionResolution? = nil,
        accepted: (() -> Void)? = nil,
        rejected: (() -> Void)? = nil
    ) {
        self.description = description
        self.resolved = resolved
        self.accepted = accepted
        self.rejected = rejected
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingSm) {
            MuiText(description, variant: .body, truncate: true)
            Spacer(minLength: MuiTokens.spacingSm)

            if let resolved {
                MuiText(
                    resolved == .accepted ? "Accepted" : "Rejected",
                    variant: .chipLabel,
                    color: resolved == .accepted ? .success : .error
                )
            } else {
                MuiButton(label: "Accept", variant: .ghost, size: .sm, leadingIcon: "checkmark", iconOnly: true) {
                    accepted?()
                }
                MuiButton(label: "Reject", variant: .ghost, size: .sm, leadingIcon: "xmark", iconOnly: true) {
                    rejected?()
                }
            }
        }
    }
}

#Preview("MuiSuggestionPreview") {
    VStack(alignment: .leading, spacing: 12) {
        MuiSuggestionPreview(description: "Rename to \"iceland-glacier-01.dng\"")
        MuiSuggestionPreview(description: "Set place to Reykjavík", resolved: .accepted)
        MuiSuggestionPreview(description: "Add keyword \"aurora\"", resolved: .rejected)
    }
    .padding()
    .frame(width: 320)
    .background(MuiTokens.bg)
}
