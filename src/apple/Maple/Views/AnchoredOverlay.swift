// AnchoredOverlay.swift — tablet/desktop anchored-overlay primitive (S7
// follow-up, #645).
//
// Apple mirror of the Web `<app-anchored-overlay>` component
// (`src/web/projects/maple-common/src/lib/shells/anchored-overlay.component.ts`).
// The two ship in lockstep so search behaviour stays uniform across
// platforms.
//
// Spec: docs/design/responsive-program/s7-search.md §2 ("Tablet" + "Desktop").
//
// Surface:
//   - `.mapleAnchoredOverlay(isPresented:widthPt:content:)` view modifier.
//     Apply to the anchor view (typically the
//     `LibrarySidebarSearchPill` button).
//   - Implementation: SwiftUI `.popover(isPresented:attachmentAnchor:)`
//     with a `.frame(width:)` on the projected content. `.popover`
//     anchors precisely to the source view, handles Esc + outside-click
//     dismissal natively, and on macOS draws a standard popover chrome
//     (no system arrow on iPad with `.popover` style hinted via
//     `.presentationCompactAdaptation(.popover)`).
//
// Scrim deviation from spec — explicit, documented:
//
//   The web spec calls for a partial scrim that dims main pane (25%)
//   and (desktop only) inspector (35%) while leaving the sidebar
//   bright. The Web component implements this with two fixed-positioned
//   scrim divs sized off the live anchor/inspector bounding rects. On
//   Apple, the equivalent would require either:
//     (a) attaching the overlay at a higher container (e.g.
//         `AppShellMacLayout` root) with bindings threaded down to the
//         pill, OR
//     (b) hand-rolling a window-level overlay layer keyed off
//         `NSWindow` / `UIWindow` geometry.
//   Both options are invasive — out of S7-follow-up scope. The Apple
//   path ships the popover without scrim today; the platform's native
//   popover dismissal-on-outside-tap covers the user-facing contract
//   (dismiss on outside interaction). Tracked as a follow-up if visual
//   parity with the web scrim is later judged essential.
//
// Wiring for S7: the search-pill button calls this with
// `<app-search>` content (i.e. `SearchView()`) once #629 lands. Until
// then the host passes a placeholder so the primitive ships exercised
// end-to-end.

import SwiftUI

extension View {
    /// Presents `content` as an anchored overlay attached to this view.
    /// Spec: docs/design/responsive-program/s7-search.md §2.
    ///
    /// - Parameters:
    ///   - isPresented: two-way binding the host owns. Outside-click +
    ///     Esc flip it to `false` (handled by SwiftUI's `.popover`).
    ///   - widthPt: panel width in points (320 tablet, 480 desktop).
    ///   - content: the overlay panel contents (e.g. `SearchView()`).
    func mapleAnchoredOverlay<OverlayContent: View>(
        isPresented: Binding<Bool>,
        widthPt: CGFloat = 320,
        @ViewBuilder content: @escaping () -> OverlayContent
    ) -> some View {
        modifier(
            MapleAnchoredOverlayModifier(
                isPresented: isPresented,
                widthPt: widthPt,
                overlayContent: content
            )
        )
    }
}

/// View modifier that presents the overlay via `.popover` anchored to
/// the bottom edge of the source view. SwiftUI handles outside-click +
/// Esc dismissal natively; no custom focus-trap needed because the
/// popover is a system-managed surface.
private struct MapleAnchoredOverlayModifier<OverlayContent: View>: ViewModifier {
    @Binding var isPresented: Bool
    let widthPt: CGFloat
    @ViewBuilder let overlayContent: () -> OverlayContent

    func body(content: Content) -> some View {
        content
            .popover(
                isPresented: $isPresented,
                attachmentAnchor: .rect(.bounds),
                arrowEdge: .top
            ) {
                overlayContent()
                    .frame(width: widthPt)
                    .accessibilityIdentifier("anchored-overlay")
                    // On iPad without explicit adaptation hint, `.popover`
                    // can fall back to a sheet on compact size classes —
                    // force it to stay a popover so the anchor-to-pill
                    // relationship survives across iPadOS multitasking
                    // size changes.
                    .modifier(MapleForcePopoverAdaptationModifier())
            }
            .animation(MapleTokens.Motion.sheetPresent, value: isPresented)
    }
}

/// `.presentationCompactAdaptation` is iOS-only and lands in iOS 16.4+.
/// macOS popovers don't adapt to sheets so the modifier is a no-op there.
private struct MapleForcePopoverAdaptationModifier: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        if #available(iOS 16.4, *) {
            content.presentationCompactAdaptation(.popover)
        } else {
            content
        }
        #else
        content
        #endif
    }
}

#if DEBUG
#Preview("AnchoredOverlay — closed") {
    AnchoredOverlayPreviewHost(initiallyOpen: false)
        .frame(width: 900, height: 600)
}

#Preview("AnchoredOverlay — open") {
    AnchoredOverlayPreviewHost(initiallyOpen: true)
        .frame(width: 900, height: 600)
}

private struct AnchoredOverlayPreviewHost: View {
    @State private var isOpen: Bool

    init(initiallyOpen: Bool) {
        _isOpen = State(initialValue: initiallyOpen)
    }

    var body: some View {
        HStack(spacing: 0) {
            // Fake sidebar — stays visible behind the popover.
            VStack(alignment: .leading, spacing: 8) {
                Button(action: { isOpen.toggle() }) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                        Text("Search photos")
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(MapleTokens.inputBg)
                    .overlay(
                        Capsule().stroke(MapleTokens.border, lineWidth: 0.5)
                    )
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("preview-search-pill")
                .padding(.horizontal, 12)
                .padding(.top, 12)
                .mapleAnchoredOverlay(isPresented: $isOpen, widthPt: 320) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Search overlay")
                            .foregroundStyle(MapleTokens.textMain)
                        Text("Real `SearchView` content lands when S7 (#629) merges.")
                            .foregroundStyle(MapleTokens.textMuted)
                    }
                    .padding(16)
                }

                Text("FOLDERS")
                    .foregroundStyle(MapleTokens.textMuted)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                Spacer()
            }
            .frame(width: 220)
            .background(MapleTokens.sidebar)

            Rectangle()
                .fill(MapleTokens.bg)
                .overlay(
                    Text("Main pane")
                        .foregroundStyle(MapleTokens.textMuted)
                )
        }
    }
}
#endif
