// AppShellIPhoneToolbar.swift — iPhone-only navigation-bar items for AppShell.
// Extracted from AppShell.swift as the final piece of the multi-PR
// AppShell split (#123, slice 6 of 6).
//
// Surface notes: the iPhone shell layers one iPhone-only button on top of
// the shared `AppShellToolbar` content — a leading hamburger that opens
// the LibrarySidebar drawer (browse mode only). It's pure `ToolbarContent`,
// so the caller composes it inside the same `.toolbar { … }` block as the
// shared content via `@ToolbarContentBuilder`:
//
//     .toolbar {
//         AppShellIPhoneToolbar(...)
//         browseToolbarContent
//     }
//
// (This used to also carry a trailing Info button that surfaced the
// DetailPanel sheet in the legacy `Mode.fullImage` full-image loupe. That
// mode was retired in #1807, which made the Info button unreachable —
// `PreviewView` and the S5 editor (`EditorDestination`) each ship their own
// Info affordance now, reached via the Library tab's NavigationStack — so
// the button and the `isFullImage` param that gated it were removed in the
// #1826 follow-up.)
//
// Keeping this as a separate `ToolbarContent` (rather than passing
// `browseToolbarContent` in as a parameter) avoids the awkward
// "ToolbarContent taking another ToolbarContent" generic shape and keeps
// the seam narrow.

#if os(iOS)
import SwiftUI

// MARK: - iPhone-only toolbar items

struct AppShellIPhoneToolbar: ToolbarContent {
    /// True when AppShell is in Browse mode — gates the leading hamburger.
    /// (Per open question 5 in the iPhone-drawer design doc, the drawer is
    /// unreachable from the viewer, so the button is hidden in Full-image.)
    let isBrowse: Bool
    /// Drawer-snapped state; the hamburger writes this with a spring
    /// animation. The drawer's own internal `@State` handles the slide;
    /// only this flag crosses the AppShell boundary.
    @Binding var isDrawerOpen: Bool

    var body: some ToolbarContent {
        // Hamburger only meaningful in browse mode (per open question 5:
        // drawer unreachable from viewer). Writes the drawer's snapped-open
        // state directly — the drawer's internal animation handles the slide.
        if isBrowse {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                        isDrawerOpen = true
                    }
                } label: {
                    Image(systemName: "line.3.horizontal")
                        .font(.system(size: 17, weight: .semibold))
                }
                .accessibilityLabel("Library")
            }
        }
        // Settings gear is provided by `AppShellToolbar` — don't duplicate
        // it here, or two buttons share the same accessibilityIdentifier and
        // UI-test lookups become ambiguous.
    }
}
#endif
