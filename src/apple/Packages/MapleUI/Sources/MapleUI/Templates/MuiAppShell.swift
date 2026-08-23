// MuiAppShell.swift — Maple UI Templates (unified-component-catalog.md
// §5). Root page layout: Navigation, Content, and an Overlay region that
// sits above both for toasts, banners, and dialogs. Regions only — no
// content of its own. Backs the Preview, Search, Board, Notifications,
// Sign In, Pairing, TV Viewer, and TV Map pages (§6).
//
// Slots are `@ViewBuilder` closures rather than the web reference's
// `slot="…"` content projection — SwiftUI has no attribute-based
// projection, so each region is its own generic parameter, same idiom
// MapleUI already uses for MuiEmbedShell's single `content` slot. Overlay
// defaults to empty: unlike the web version (which needs an explicit
// `pointer-events: none` on the overlay region so an empty one doesn't
// swallow clicks to Nav/Content below it), an `EmptyView` in a SwiftUI
// `ZStack` never intercepts hit-testing, so no equivalent workaround is
// needed here.

import SwiftUI

public enum MuiAppShellNavPlacement: Sendable {
    /// Navigation renders as a full-width bar above Content.
    case top
    /// Navigation renders as a rail beside Content.
    case side
}

public struct MuiAppShell<Nav: View, Content: View, Overlay: View>: View {
    public let navPlacement: MuiAppShellNavPlacement
    public let nav: Nav
    public let content: Content
    public let overlay: Overlay

    public init(
        navPlacement: MuiAppShellNavPlacement = .top,
        @ViewBuilder nav: () -> Nav,
        @ViewBuilder content: () -> Content,
        @ViewBuilder overlay: () -> Overlay = { EmptyView() }
    ) {
        self.navPlacement = navPlacement
        self.nav = nav()
        self.content = content()
        self.overlay = overlay()
    }

    public var body: some View {
        ZStack {
            switch navPlacement {
            case .top:
                VStack(spacing: 0) {
                    nav
                    content.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .side:
                HStack(spacing: 0) {
                    nav
                    content.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }

            overlay
        }
    }
}

#Preview("MuiAppShell — top nav") {
    MuiAppShell {
        Rectangle().fill(MuiTokens.surface).frame(height: 48)
            .overlay(MuiText("Navigation", variant: .toolLabel, color: .muted))
    } content: {
        MuiTokens.imageCanvas
            .overlay(MuiText("Content", variant: .body, color: .muted))
    } overlay: {
        VStack {
            Spacer()
            HStack {
                Spacer()
                MuiToast(variant: .success, message: "Saved")
                    .padding()
            }
        }
    }
    .frame(width: 360, height: 220)
}

#Preview("MuiAppShell — side nav") {
    MuiAppShell(navPlacement: .side) {
        Rectangle().fill(MuiTokens.surface).frame(width: 64)
            .overlay(MuiText("Nav", variant: .toolLabel, color: .muted))
    } content: {
        MuiTokens.imageCanvas
            .overlay(MuiText("Content", variant: .body, color: .muted))
    }
    .frame(width: 360, height: 220)
}
