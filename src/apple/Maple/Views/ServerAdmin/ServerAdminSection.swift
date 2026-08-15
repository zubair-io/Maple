// ServerAdminSection.swift — the ServerAdmin sidebar model.
//
// One case per delivered page. Later tickets in epic #2765 add their case
// here as they land (#2767 Cloudflare, #2768 Workers, #2773 Imports), so
// the sidebar never advertises a page that doesn't exist yet.

import Foundation

enum ServerAdminSection: String, CaseIterable, Identifiable, Hashable {
    case network
    case cloudflare

    var id: String { rawValue }

    var title: String {
        switch self {
        case .network: return "Network"
        case .cloudflare: return "Cloudflare"
        }
    }

    var icon: String {
        switch self {
        case .network: return "wifi"
        case .cloudflare: return "globe"
        }
    }

    /// Mirrors the web's `ownerOnly` nav filter.
    ///
    /// Enforcement is inconsistent server-side and the difference matters:
    /// `/api/cloudflare/*` is genuinely `requireOwner` and returns 403 to a
    /// member, whereas `/api/network/config` is only `requireAuth`, so
    /// hiding it is presentation. Never treat a hidden row as access control.
    var isOwnerOnly: Bool {
        switch self {
        case .network, .cloudflare: return true
        }
    }

    static func visible(isOwner: Bool) -> [ServerAdminSection] {
        allCases.filter { isOwner || !$0.isOwnerOnly }
    }
}
