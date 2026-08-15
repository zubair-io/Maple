// ServerAdminSection.swift — the ServerAdmin sidebar model.
//
// One case per delivered page. Later tickets in epic #2765 add their case
// here as they land, so the sidebar never advertises a page that doesn't
// exist yet.

import Foundation

enum ServerAdminSection: String, CaseIterable, Identifiable, Hashable {
    case workers
    case network
    case cloudflare
    case imports

    var id: String { rawValue }

    var title: String {
        switch self {
        case .workers: return "Workers"
        case .network: return "Network"
        case .cloudflare: return "Cloudflare"
        case .imports: return "Imports"
        }
    }

    var icon: String {
        switch self {
        case .workers: return "gauge.with.dots.needle.bottom.50percent"
        case .network: return "wifi"
        case .cloudflare: return "globe"
        case .imports: return "tray.and.arrow.down"
        }
    }

    /// Mirrors the web's `ownerOnly` nav filter.
    ///
    /// Enforcement is inconsistent server-side and the difference matters:
    /// `/api/cloudflare/*` is genuinely `requireOwner` and returns 403 to a
    /// member, whereas `/api/network/config` and `/api/imports/*` are only
    /// `requireAuth`, so hiding them is presentation. Never treat a hidden
    /// row as access control.
    var isOwnerOnly: Bool {
        switch self {
        // Workers and Imports match the web's ownerOnly nav flag, though
        // /api/workers/* and /api/imports/* are only requireAuth server-side.
        case .workers, .network, .cloudflare, .imports: return true
        }
    }

    static func visible(isOwner: Bool) -> [ServerAdminSection] {
        allCases.filter { isOwner || !$0.isOwnerOnly }
    }
}
