// MuiPageHeader.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.5; Built from: Button, Text, Icon). A title bar with an optional
// leading back action, a centered truncating title, a trailing action
// slot, and an optional overflow ("more") action.

import SwiftUI

public struct MuiPageHeader<Actions: View>: View {
    public let title: String
    public let showBack: Bool
    public let showMore: Bool
    public let back: (() -> Void)?
    public let more: (() -> Void)?
    @ViewBuilder public let actions: Actions

    public init(
        title: String,
        showBack: Bool = true,
        showMore: Bool = false,
        back: (() -> Void)? = nil,
        more: (() -> Void)? = nil,
        @ViewBuilder actions: () -> Actions = { EmptyView() }
    ) {
        self.title = title
        self.showBack = showBack
        self.showMore = showMore
        self.back = back
        self.more = more
        self.actions = actions()
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingSm) {
            if showBack {
                MuiButton(label: "Back", variant: .ghost, leadingIcon: "chevron.left", iconOnly: true) {
                    back?()
                }
            }

            MuiText(title, variant: .sheetTitle, truncate: true)
                .frame(maxWidth: .infinity, alignment: showBack ? .leading : .leading)

            actions

            if showMore {
                MuiButton(label: "More", variant: .ghost, leadingIcon: "ellipsis", iconOnly: true) {
                    more?()
                }
            }
        }
        .padding(.horizontal, MuiTokens.spacingMd)
        .padding(.vertical, MuiTokens.spacingSm)
        .frame(minHeight: 44)
    }
}

#Preview("MuiPageHeader") {
    VStack(spacing: 12) {
        MuiPageHeader(title: "IMG_0042.dng", showMore: true, actions: {
            MuiButton(label: "Share", variant: .secondary, leadingIcon: "square.and.arrow.up", iconOnly: true) {}
        })
        MuiPageHeader(title: "Settings", showBack: false)
    }
    .background(MuiTokens.bg)
}
