// ServerAdminSection.swift — the ServerAdmin sidebar model.
//
// One case per delivered page. Later tickets in epic #2765 add their case
// here as they land (#2772 face models + maintenance remains), so the
// sidebar never advertises a page that doesn't exist yet.

import Foundation

enum ServerAdminSection: String, CaseIterable, Identifiable, Hashable {
    case workers
    case network
    case cloudflare
    case enrichment
    case imports

    var id: String { rawValue }

    var title: String {
        switch self {
        case .workers: return "Workers"
        case .network: return "Network"
        case .cloudflare: return "Cloudflare"
        case .enrichment: return "Enrichment"
        case .imports: return "Imports"
        }
    }

    var icon: String {
        switch self {
        case .workers: return "gauge.with.dots.needle.bottom.50percent"
        case .network: return "wifi"
        case .cloudflare: return "globe"
        case .enrichment: return "sparkle"
        case .imports: return "tray.and.arrow.down"
        }
    }

    /// Mirrors the web's `ownerOnly` nav filter.
    ///
    /// Enforcement is inconsistent server-side and the difference matters:
    /// `/api/cloudflare/*` and the enrichment `PUT` are genuinely
    /// `requireOwner` and return 403 to a member, whereas
    /// `/api/network/config`, `/api/workers/*`, `/api/imports/*` and
    /// enrichment's `GET` are only `requireAuth`. Hiding those is
    /// presentation — never treat a hidden row as access control.
    var isOwnerOnly: Bool {
        switch self {
        // Every page matches the web's ownerOnly nav flag. Only Cloudflare
        // and the enrichment PUT are actually enforced server-side; the
        // rest are gated here for parity with the web, not for safety.
        case .workers, .network, .cloudflare, .enrichment, .imports: return true
        }
    }

    static func visible(isOwner: Bool) -> [ServerAdminSection] {
        allCases.filter { isOwner || !$0.isOwnerOnly }
    }
}
