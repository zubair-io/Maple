// MapEmptyState.swift — shown by `AppShellCenterColumn` in place of
// `MapView` while `.map` is selected but there is no map session to
// render yet (#2848).
//
// Copy + layout mirror `PhoneSearchEmptyState` (`PhoneSearchStub.swift`) —
// the iPhone Search tab's own account-less empty state, the closest
// existing precedent for an account-wide cloud surface with nothing
// connected. Unlike that view this one is NOT `#if os(iOS)`-gated: it
// renders on the Mac/iPad sidebar's MAP row (via `AppShellMacLayout`) as
// well as the iPhone Map tab (via `PhoneTabShell.mapTabContent`) — both
// route through the same `AppShellCenterColumn` branch.
//
// `MapUnavailableReason` (MapleCloudKit) carries three cases:
//   - `.noAccount`      — no cloud account connected at all.
//   - `.signInRequired` — an account is connected but not signed in.
//   - `.connecting`     — bootstrapping an already-persisted token; a
//                         spinner, not a dead end, so it gets no copy.

import SwiftUI
import MapleCore

struct MapEmptyState: View {
    let reason: MapUnavailableReason

    var body: some View {
        Group {
            switch reason {
            case .connecting:
                ProgressView()
            case .noAccount, .signInRequired:
                VStack(spacing: 12) {
                    Image(systemName: "map")
                        .font(.system(size: 40))
                        .foregroundStyle(MapleTokens.textMuted)
                    Text(title)
                        .font(MapleTokens.Typography.sheetTitle)
                        .foregroundStyle(MapleTokens.textMain)
                    Text(message)
                        .font(MapleTokens.Typography.rowLabel)
                        .foregroundStyle(MapleTokens.textMuted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 320)
                }
                .padding(24)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.bg.ignoresSafeArea())
        .accessibilityIdentifier(accessibilityIdentifier)
    }

    private var title: String {
        switch reason {
        case .connecting: return ""
        case .noAccount: return "See your photos on a map"
        case .signInRequired: return "Sign in to see your map"
        }
    }

    private var message: String {
        switch reason {
        case .connecting: return ""
        case .noAccount:
            return "Connect a Maple Cloud account to plot your located photos on the map."
        case .signInRequired:
            return "Your Maple Cloud account is connected but signed out. Sign in again to load the map."
        }
    }

    private var accessibilityIdentifier: String {
        switch reason {
        case .connecting: return "map-empty-connecting"
        case .noAccount: return "map-empty-no-account"
        case .signInRequired: return "map-empty-sign-in-required"
        }
    }
}
