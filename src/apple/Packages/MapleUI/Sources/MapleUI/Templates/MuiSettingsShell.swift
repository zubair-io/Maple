// MuiSettingsShell.swift — Maple UI Templates (unified-component-catalog.md
// §5). Two-region layout: a Section nav (fixed width) and a Pane
// (max-width, centered). Backs the Settings and Admin pages (§6). Regions
// only — no content of its own.
//
// Below the phone-tier breakpoint (`MuiSettingsShellMath`), the fixed-width
// nav column stacks above the pane at full width instead of sitting beside
// it — mirrors the iOS Settings app's list-then-detail pattern rather than
// trying to fit two columns on a phone. Width comes from a
// `GeometryReader`, same reasoning as `MuiSplitLayout`.

import SwiftUI

public struct MuiSettingsShell<Nav: View, Pane: View>: View {
    public let navWidth: Double
    public let paneMaxWidth: Double
    public let nav: Nav
    public let pane: Pane

    public init(
        navWidth: Double = 240,
        paneMaxWidth: Double = 640,
        @ViewBuilder nav: () -> Nav,
        @ViewBuilder pane: () -> Pane
    ) {
        self.navWidth = navWidth
        self.paneMaxWidth = paneMaxWidth
        self.nav = nav()
        self.pane = pane()
    }

    public var body: some View {
        GeometryReader { geo in
            let stacked = MuiSettingsShellMath.isStacked(hostWidth: Double(geo.size.width))

            if stacked {
                VStack(spacing: 0) {
                    nav.frame(maxWidth: .infinity, alignment: .leading)
                    ScrollView {
                        pane
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(MuiTokens.spacingLg)
                    }
                }
            } else {
                HStack(spacing: 0) {
                    nav
                        .frame(width: navWidth, alignment: .leading)
                        .frame(maxHeight: .infinity)
                        .clipped()
                    ScrollView {
                        pane
                            .frame(maxWidth: paneMaxWidth, alignment: .leading)
                            .frame(maxWidth: .infinity)
                            .padding(MuiTokens.spacingLg)
                    }
                }
            }
        }
    }
}

#Preview("MuiSettingsShell") {
    MuiSettingsShell {
        VStack(alignment: .leading) {
            MuiText("General", variant: .rowLabel)
            MuiText("Workers", variant: .rowLabel)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MuiTokens.surface)
    } pane: {
        MuiText("Pane content", variant: .body, color: .muted)
    }
    .frame(width: 700, height: 320)
}

#Preview("MuiSettingsShell — stacked (phone width)") {
    MuiSettingsShell {
        VStack(alignment: .leading) {
            MuiText("General", variant: .rowLabel)
            MuiText("Workers", variant: .rowLabel)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MuiTokens.surface)
    } pane: {
        MuiText("Pane content", variant: .body, color: .muted)
    }
    .frame(width: 360, height: 400)
}
