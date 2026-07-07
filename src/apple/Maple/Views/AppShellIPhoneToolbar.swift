// AppShellIPhoneToolbar.swift — iPhone-only navigation-bar items for AppShell.
// Extracted from AppShell.swift as the final piece of the multi-PR
// AppShell split (#123, slice 6 of 6).
//
// Surface notes: the iPhone shell layers two iPhone-only buttons on top of
// the shared `AppShellToolbar` content — a leading hamburger that opens
// the LibrarySidebar drawer (browse mode only) and a trailing Info button
// that surfaces the DetailPanel sheet (full-image mode only). Both are
// pure `ToolbarContent`, so the caller composes them inside the same
// `.toolbar { … }` block as the shared content via `@ToolbarContentBuilder`:
//
//     .toolbar {
//         AppShellIPhoneToolbar(...)
//         browseToolbarContent
//     }
//
// Keeping these as a separate `ToolbarContent` (rather than passing
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
    /// Gates the trailing Info button (→ `AppShellIPhoneShell`'s
    /// `iPhoneInfoSheet`). Always `false` since #1807 retired the legacy
    /// `Mode.fullImage` surface this toolbar used to key off — `PreviewView`
    /// and the S5 editor each ship their own Info affordance now
    /// (`PreviewView.showInfo` / `EditorDestination`'s `onInfo`), reached via
    /// the Library tab's `NavigationStack` push rather than this shell's
    /// toolbar. The parameter and `iPhoneInfoSheet` are left in place
    /// (rather than torn out here) pending a follow-up that traces every
    /// `EditorDestination` Info path before deleting the sheet.
    let isFullImage: Bool
    /// Drawer-snapped state; the hamburger writes this with a spring
    /// animation. The drawer's own internal `@State` handles the slide;
    /// only this flag crosses the AppShell boundary.
    @Binding var isDrawerOpen: Bool
    /// Tapped when the user hits the Info button. AppShell flips its own
    /// `iPhoneInfoSheet` flag inside the closure.
    let onInfo: () -> Void

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
        // Info button reaches the DetailPanel sheet; only meaningful in
        // Full-image mode (the panel is suppressed entirely in Browse —
        // sidecar info belongs to the editor view).
        if isFullImage {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onInfo) {
                    Image(systemName: "info.circle")
                }
                .accessibilityLabel("Info")
            }
        }
        // Settings gear is provided by `AppShellToolbar` — don't duplicate
        // it here, or two buttons share the same accessibilityIdentifier and
        // UI-test lookups become ambiguous.
    }
}
#endif
