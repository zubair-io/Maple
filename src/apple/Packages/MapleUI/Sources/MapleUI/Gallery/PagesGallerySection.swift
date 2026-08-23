// PagesGallerySection.swift — Pages tab: specimen cards for wave A7's 15
// page compositions (catalog §6), the final tier of the Apple catalog.
//
// A page is a full template-plus-organisms composition, sized for a real
// desktop or tablet window — far bigger than a gallery chip has room for.
// Rather than re-deriving a second, gallery-only miniature layout per
// page (a second thing to keep at parity with the real one), each card
// renders the actual `MuiPageX` view at its native desktop size inside a
// `PageChip`, then shrinks the whole rendered result down with
// `.scaleEffect` to fit a small fixed-size chip — same "live specimen,
// just smaller" contract every earlier tier's gallery card already makes,
// extended with a scale step because pages don't fit at 1:1.
//
// `.scaleEffect` runs after layout, not during it, so the page still
// lays itself out at `native` (a `GeometryReader`-driven template like
// Split Layout sees a normal desktop width and picks the real desktop
// layout) — the visual shrink is the only thing that changes.

import SwiftUI

struct PagesGallerySection: View {
    private let columns = [GridItem(.adaptive(minimum: 340), spacing: MuiTokens.spacingMd, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
            MuiText("All 15 Pages", variant: .eyebrow, color: .muted)
            LazyVGrid(columns: columns, alignment: .leading, spacing: MuiTokens.spacingMd) {
                card(name: "Browse", purpose: "Sidebar, Collection Grid, Timeline, Map Surface, Toolbar") { MuiPageBrowse() }
                card(name: "Editor", purpose: "Image Canvas, Tool Dock, Control Surface, Adjustments, Inspector, Filmstrip") { MuiPageEditor() }
                card(name: "Document", purpose: "Sidebar, Rich Text Editor, Backlinks Panel, Version History Panel") { MuiPageDocument() }
                card(name: "Preview", purpose: "Preview Surface") { MuiPagePreview() }
                card(name: "Search", purpose: "Search") { MuiPageSearch() }
                card(name: "Board", purpose: "Kanban Board") { MuiPageBoard() }
                card(name: "Chat", purpose: "Chat, Thread Panel") { MuiPageChat() }
                card(name: "Notifications", purpose: "Notification Feed") { MuiPageNotifications() }
                card(name: "Settings", purpose: "Settings Section, Device List, User Management") { MuiPageSettings() }
                card(name: "Admin", purpose: "Pipeline Monitor, Setup Wizard, Backup Monitor, Diagnostics") { MuiPageAdmin() }
                card(name: "Sign In", purpose: "Form Field, Button, Banner") { MuiPageSignIn() }
                card(name: "Pairing", purpose: "Pair Device") { MuiPagePairing() }
                card(name: "TV Timeline", purpose: "Timeline, Collection Grid") { MuiPageTVTimeline() }
                card(name: "TV Viewer", purpose: "Preview Surface") { MuiPageTVViewer() }
                card(name: "TV Map", purpose: "Map Surface") { MuiPageTVMap() }
            }
        }
    }

    private func card<Content: View>(name: String, purpose: String, @ViewBuilder content: () -> Content) -> some View {
        GallerySpecimenCard(name: name, purpose: purpose) {
            PageChip(content: content)
        }
    }
}

/// A live page, laid out at a real desktop size (`native`) and then
/// visually shrunk with `.scaleEffect` to fit a small, fixed-size gallery
/// chip (`chip`) — `.frame(..., alignment: .topLeading)` after the scale
/// crops to that chip rather than leaving blank space, since a scaled
/// view keeps reporting its pre-scale layout size to its parent.
private struct PageChip<Content: View>: View {
    let native: CGSize
    let chip: CGSize
    let content: Content

    init(native: CGSize = CGSize(width: 960, height: 600), chip: CGSize = CGSize(width: 340, height: 212), @ViewBuilder content: () -> Content) {
        self.native = native
        self.chip = chip
        self.content = content()
    }

    var body: some View {
        let scale = chip.width / native.width
        content
            .frame(width: native.width, height: native.height)
            .clipped()
            .scaleEffect(scale, anchor: .topLeading)
            .frame(width: chip.width, height: chip.height, alignment: .topLeading)
            .clipped()
            .background(MuiTokens.bg)
    }
}

#Preview {
    ScrollView {
        PagesGallerySection().padding()
    }
    .background(MuiTokens.bg)
}
