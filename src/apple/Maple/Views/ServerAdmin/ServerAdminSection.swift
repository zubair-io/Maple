// ServerAdminSection.swift — the ServerAdmin sidebar model.
//
// One case per delivered page. Later tickets in epic #2765 add their case
// here as they land (#2767 Cloudflare, #2768 Workers, #2773 Imports), so
// the sidebar never advertises a page that doesn't exist yet.

import Foundation

enum ServerAdminSection: String, CaseIterable, Identifiable, Hashable {
    case network

    var id: String { rawValue }

    var title: String {
        switch self {
        case .network: return "Network"
        }
    }

    var icon: String {
        switch self {
        case .network: return "wifi"
        }
    }

    /// Mirrors the web's `ownerOnly` nav filter. This is presentation
    /// only: `/api/network/config` is `requireAuth` server-side, so a
    /// non-owner is not actually blocked by the API. Never treat a hidden
    /// row as an access control.
    var isOwnerOnly: Bool {
        switch self {
        case .network: return true
        }
    }

    static func visible(isOwner: Bool) -> [ServerAdminSection] {
        allCases.filter { isOwner || !$0.isOwnerOnly }
    }
}
