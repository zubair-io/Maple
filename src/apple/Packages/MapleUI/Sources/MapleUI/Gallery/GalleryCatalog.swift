// GalleryCatalog.swift — static element-name lists for the gallery's
// "coming in a later wave" placeholder rows.
//
// Source of truth: docs/unified-component-catalog.md. Names are copied
// verbatim from that file's tables — this is presentation data for an
// unbuilt-tier placeholder, not a live parser, so a flat literal list is
// the right amount of machinery (no markdown-parsing dependency for a
// static row of names that changes only when the catalog itself does).

import Foundation

enum GalleryCatalog {
    // Molecules — Level 1 (§2) has no placeholder list anymore: wave A3a
    // shipped §2.1-2.3 (Form & entry, Selection, Feedback & messaging — 19
    // molecules, see `MoleculesL1GallerySection`) and wave A3b shipped
    // §2.4-2.7 (Overlays & menus, Structure, Data plots, Media — 23
    // molecules, see `MoleculesL1GallerySection2`). All 42 molecules
    // cataloged at this tier are built.
    //
    // Molecules — Level 2 (§3) has no placeholder list anymore either: wave
    // A4 shipped all 24 (see `MoleculesL2GallerySection`).
    //
    // Templates (§5) has no placeholder list anymore either: wave A5
    // shipped all 7 (see `TemplatesGallerySection`).

    // Organisms §4.1-4.3 (§4.1 Collections, §4.2 Navigation, §4.3
    // Inspectors & panels — 23 organisms) has no placeholder list anymore
    // either: wave A6a shipped all 23 (see `OrganismsGallerySection`).
    //
    // Organisms §4.4-4.8 (Modals, Editing surfaces, Map, Communication,
    // Configuration — 32 organisms) has no placeholder list anymore
    // either: wave A6b shipped all 32 (see `OrganismsGallerySection`'s
    // §4.4-4.8 sections).

    /// Pages (§6).
    static let pages: [String] = [
        "Browse", "Editor", "Document", "Preview", "Search", "Board", "Chat", "Notifications",
        "Settings", "Admin", "Sign In", "Pairing", "TV Timeline", "TV Viewer", "TV Map",
    ]
}
