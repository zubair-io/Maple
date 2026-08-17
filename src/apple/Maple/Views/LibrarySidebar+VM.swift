// LibrarySidebar+VM.swift — pure section-visibility rules for the sidebar
// (#2925).
//
// The rule: a source section the user has nothing connected in does not
// appear. Registering and reconnecting sources lives on Settings → Sources
// (`LibrarySourcesSettingsView`), so hiding a section no longer strands
// anything — which is what made the old "No local folders / Add one"
// placeholder and the childless "Network (SMB)" row necessary.
//
// Pattern (issue #192): a sibling `+VM.swift` holding the derivations,
// unit-testable in isolation. This file MUST NOT `import SwiftUI` — a grep
// gate in CI enforces it.

import Foundation

/// Namespace for pure `LibrarySidebar` derivations.
enum LibrarySidebarVM {

    /// Local folders. Nothing saved → no section.
    static func showsFoldersSection(savedFolderCount: Int) -> Bool {
        savedFolderCount > 0
    }

    /// Connections (SMB). The section's only content is the saved-share
    /// list, so with none saved it was a disclosure row that opened onto
    /// nothing.
    static func showsConnectionsSection(savedShareCount: Int) -> Bool {
        savedShareCount > 0
    }

    /// One registered Maple server's section.
    ///
    /// - `isSignedIn`: false keeps the section visible. Sign-in is offered
    ///   inside it, and a signed-out server reports zero folders — hiding on
    ///   that would remove the only way back in.
    /// - `hasFileAccess`: false **hides** the section. A member without the
    ///   permission is served an empty tree by #2899's folder gate, and
    ///   browsing is 403'd server-side anyway — so the section is a header
    ///   over content they cannot reach, which is the same clutter an
    ///   unreachable root is. Checked before the count because the count is
    ///   meaningless here: the roots may well be connected, they're just
    ///   not this member's to browse. Settings → Sources still lists the
    ///   server, and Settings → Cloud still manages it.
    /// - `connectedFolderCount`: `nil` means the folder list hasn't loaded
    ///   yet. Visible: a server that flickered out for the duration of its
    ///   own fetch would be worse than one that arrives a beat late.
    ///
    /// So two hiding cases: no permission to browse, or nothing left to
    /// browse once #2898's root filter has run.
    static func showsCloudServerSection(
        isSignedIn: Bool,
        hasFileAccess: Bool,
        connectedFolderCount: Int?
    ) -> Bool {
        guard isSignedIn else { return true }
        guard hasFileAccess else { return false }
        guard let count = connectedFolderCount else { return true }
        return count > 0
    }

    /// Photos Library is never hidden. It is the only route to the
    /// permission panel that grants access (#2454), and an unauthorized
    /// library reports zero photos — so a count-based rule would hide the
    /// section precisely when the user needs it, with no way back. Exists
    /// as a named function rather than a comment at the call site so the
    /// exception is visible to anyone extending the rule above.
    static var showsPhotosSection: Bool { true }
}
