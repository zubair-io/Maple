// AppShell+PhoneSearchSeed.swift — iPhone Search tab seeding (#3163).
//
// A widget deep link (`AppShell+DeepLink.swift.navigateToSearch`) or a Map
// pin/cluster tap (`AppShell+Map.swift.selectMapPlace`) both route here on
// iPhone instead of `activateSearch(server:libraryID:params:)`
// (`AppShell+CloudActions.swift`), which presents the mac/iPad three-column
// shell's `CloudSearchView` overlay — a second, duplicated search UI on the
// phone, which already has `PhoneSearchTab` as its production search
// surface. Mac/iPad keep the overlay unchanged.

import Foundation
import MapleCore

#if os(iOS)
@MainActor
extension AppShell {
    /// Switch to the iPhone Search tab and seed it with `params`.
    ///
    /// `libraryID` is forced onto `params` the same way
    /// `activateSearch(server:libraryID:params:)` forces it onto its own
    /// `resolvedParams` — a caller-seeded `params.libraryID` can never
    /// silently search the wrong scope (e.g. Map's account-wide tap always
    /// passing `nil` regardless of what `params` already carried).
    ///
    /// `PhoneSearchTab` applies `pendingPhoneSearchSeed` once its
    /// account-wide session is ready (immediately if it already is) and
    /// clears it after submitting. Flipping `cm.tab.shell` via
    /// `UserDefaults` directly — not a binding — mirrors
    /// `switchToLibraryTab()` (`AppShell+DeepLink.swift`): `PhoneTabShell`'s
    /// `@AppStorage("cm.tab.shell")` observes the write regardless of who
    /// made it.
    func switchToPhoneSearchTab(seeding params: SearchParams, libraryID: String?) {
        var resolvedParams = params
        resolvedParams.libraryID = libraryID
        pendingPhoneSearchSeed = resolvedParams
        UserDefaults.standard.set("search", forKey: "cm.tab.shell")
    }
}
#endif
