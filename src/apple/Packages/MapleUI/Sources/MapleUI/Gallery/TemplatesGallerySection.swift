// TemplatesGallerySection.swift — Templates tab: specimen cards for wave
// A5's 7 layout Templates (catalog §5). Each card hosts a fixed-size,
// dark-chip instance of the real Template with labeled placeholder blocks
// standing in for its regions (no organism content exists yet — that's
// what §5's "Regions only. No content." means). The modal Templates
// (Overlay Shell, Sheet Shell, Drawer Shell) render via their `contained`
// input so they stay inside the card instead of covering the gallery
// screen; Split Layout renders with `collapseEnabled: false` so all three
// regions stay visible at the card's narrow width.

import SwiftUI

struct TemplatesGallerySection: View {
    private let columns = [GridItem(.adaptive(minimum: 260), spacing: MuiTokens.spacingMd, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
            MuiText("All 7 Templates", variant: .eyebrow, color: .muted)
            LazyVGrid(columns: columns, alignment: .leading, spacing: MuiTokens.spacingMd) {
                appShellCard
                splitLayoutCard
                tabShellCard
                settingsShellCard
                overlayShellCard
                sheetShellCard
                drawerShellCard
            }
        }
    }

    private var appShellCard: some View {
        GallerySpecimenCard(name: "App Shell", purpose: "Navigation · Content · Overlay regions") {
            MuiAppShell {
                RegionBlock(label: "Nav", tint: MuiTokens.surfaceAlt).frame(height: 26)
            } content: {
                RegionBlock(label: "Content", tint: MuiTokens.imageCanvas)
            } overlay: {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        RegionBlock(label: "Overlay", tint: MuiTokens.primary.opacity(0.3))
                            .frame(width: 70, height: 24)
                            .padding(6)
                    }
                }
            }
            .frame(height: 140)
        }
    }

    private var splitLayoutCard: some View {
        GallerySpecimenCard(name: "Split Layout", purpose: "Sidebar · Center · Detail, resizable") {
            MuiSplitLayout(sidebarWidth: .constant(72), detailWidth: .constant(72), collapseEnabled: false) {
                RegionBlock(label: "Side", tint: MuiTokens.surfaceAlt)
            } center: {
                RegionBlock(label: "Center", tint: MuiTokens.imageCanvas)
            } detail: {
                RegionBlock(label: "Detail", tint: MuiTokens.surfaceAlt)
            }
            .frame(height: 140)
        }
    }

    private var tabShellCard: some View {
        GallerySpecimenCard(name: "Tab Shell", purpose: "Tab bar top/bottom · Content") {
            TabShellDemo().frame(height: 140)
        }
    }

    private var settingsShellCard: some View {
        GallerySpecimenCard(name: "Settings Shell", purpose: "Section nav · Pane, max-width") {
            MuiSettingsShell(navWidth: 72) {
                RegionBlock(label: "Nav", tint: MuiTokens.surfaceAlt).frame(height: 26)
            } pane: {
                RegionBlock(label: "Pane", tint: MuiTokens.imageCanvas)
                    .frame(maxWidth: .infinity, minHeight: 80)
            }
            .frame(height: 160)
        }
    }

    private var overlayShellCard: some View {
        GallerySpecimenCard(name: "Overlay Shell", purpose: "Scrim · Header · Body · Footer, sm/md/lg/full") {
            MuiOverlayShell(isPresented: true, size: .sm, contained: true) {
                RegionBlock(label: "Header", tint: MuiTokens.surfaceAlt).frame(height: 24)
            } content: {
                RegionBlock(label: "Body", tint: MuiTokens.imageCanvas).frame(height: 50)
            } footer: {
                RegionBlock(label: "Footer", tint: MuiTokens.surfaceAlt).frame(height: 24)
            }
            .frame(height: 180)
        }
    }

    private var sheetShellCard: some View {
        GallerySpecimenCard(name: "Sheet Shell", purpose: "Scrim · Grab handle · Body, detents") {
            MuiSheetShell(isPresented: true, detents: [0.75], contained: true) {
                RegionBlock(label: "Body", tint: MuiTokens.imageCanvas)
            }
            .frame(height: 180)
        }
    }

    private var drawerShellCard: some View {
        GallerySpecimenCard(name: "Drawer Shell", purpose: "Scrim · edge Panel") {
            MuiDrawerShell(isPresented: true, width: 120, contained: true) {
                RegionBlock(label: "Panel", tint: MuiTokens.imageCanvas)
            }
            .frame(height: 140)
        }
    }
}

/// A labeled placeholder block standing in for a Template region — §5's
/// "Regions only. No content." means these cards have nothing real to
/// project into each slot, so a tinted rectangle with its region name is
/// the specimen itself.
private struct RegionBlock: View {
    let label: String
    let tint: Color

    var body: some View {
        Rectangle()
            .fill(tint)
            .overlay(
                Text(label)
                    .font(MuiTokens.TypeScale.font(.toolLabel))
                    .foregroundStyle(MuiTokens.textMuted)
            )
    }
}

/// `MuiTabShell` needs an `activeId` binding, which a computed `var` card
/// can't own — a tiny wrapper view gives it a home.
private struct TabShellDemo: View {
    @State private var activeId = "grid"

    var body: some View {
        MuiTabShell(
            tabs: [MuiTab(id: "grid", label: "Grid"), MuiTab(id: "map", label: "Map")],
            activeId: $activeId,
            placement: .top
        ) {
            RegionBlock(label: "Content", tint: MuiTokens.imageCanvas)
        }
    }
}

#Preview {
    ScrollView {
        TemplatesGallerySection().padding()
    }
    .background(MuiTokens.bg)
}
