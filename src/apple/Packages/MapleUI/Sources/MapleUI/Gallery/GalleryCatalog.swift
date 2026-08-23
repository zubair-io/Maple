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

    /// Molecules — Level 2 (§3).
    static let moleculesL2: [String] = [
        "Media Cell", "Card", "Dialog", "Settings Row", "Embed Shell", "Description Field",
        "Transcript Block", "Faces Row", "Place Row", "Vision Row", "Keyword Row", "Preview List",
        "Progress Step", "Suggestion Preview", "Bot Output", "Endpoint Form", "Response Viewer",
        "Filmstrip Row", "Filmstrip Rail", "QR Scanner", "Chat Message", "Typing Indicator",
        "Todo Popover", "Event Popover",
    ]

    /// Organisms (§4).
    static let organisms: [String] = [
        "Collection Grid", "List View", "Timeline", "Kanban Board", "Filmstrip", "Search Results",
        "Sidebar", "Tool Dock", "Search", "Filter Panel",
        "Inspector Panel", "Info Panel", "Enrichment Panel", "Adjustments Panel", "Color Grading Panel",
        "HSL Panel", "Tone Curve Panel", "Film Panel", "Presets Panel", "Scopes Panel",
        "Backlinks Panel", "Version History Panel", "Thread Panel",
        "Export", "Batch Rename", "Batch Metadata", "Move To", "Panorama Merge", "Selective Paste",
        "Library Picker", "Add Server", "Pair Device", "Share", "Template Gallery", "Card Detail", "Result Report",
        "Image Canvas", "Crop Overlay", "Crop Toolbar", "Control Surface", "Mobile Control Bar",
        "Rich Text Editor", "Whiteboard Canvas", "Structured Data Editor", "Preview Surface",
        "Map Surface",
        "Chat", "Notification Feed",
        "Settings Section", "Pipeline Monitor", "Setup Wizard", "User Management", "Device List",
        "Backup Monitor", "Diagnostics",
    ]

    /// Templates (§5).
    static let templates: [String] = [
        "App Shell", "Split Layout", "Tab Shell", "Settings Shell",
        "Overlay Shell", "Sheet Shell", "Drawer Shell",
    ]

    /// Pages (§6).
    static let pages: [String] = [
        "Browse", "Editor", "Document", "Preview", "Search", "Board", "Chat", "Notifications",
        "Settings", "Admin", "Sign In", "Pairing", "TV Timeline", "TV Viewer", "TV Map",
    ]
}
