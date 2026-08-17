// BrowseEmptyState.swift — the "nothing to show" overlay shared by both
// photo grids.
//
// Lifted out of BrowseGrid.swift (#2924). It was `private` there, which
// meant the iPhone's `LibraryGrid` had no empty state at all: an empty
// `vm.assets` rendered a blank `ScrollView`, so the Photos-permission
// panel (#2454) — the only in-app route to requesting access — was
// unreachable on phone. One file, both call sites.
//
// Every branch decision lives in the pure `BrowseGridVM` selectors
// (BrowseGrid+VM.swift, issue #192); this view only maps the returned
// case onto a SwiftUI subtree.

import SwiftUI
import MapleCore
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Centred illustration + contextual text shown when `vm.assets` is empty.
struct BrowseEmptyState: View {
    let vm: BrowseViewModel
    let onGrantPhotosAccess: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: iconName)
                .font(.system(size: 48))
                .foregroundStyle(MapleTokens.textMuted)

            Text(primaryTitle)
                .font(MapleTokens.Typography.sheetTitle)
                .foregroundStyle(MapleTokens.textMain)

            secondary
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var iconName: String {
        BrowseGridVM.emptyStateIconName(photosAuthNeeded: vm.photosAuthNeeded)
    }

    private var primaryTitle: String {
        BrowseGridVM.emptyStatePrimaryTitle(
            photosAuthNeeded: vm.photosAuthNeeded,
            photosAuthCanRequest: vm.photosAuthCanRequest
        )
    }

    private var secondaryCase: BrowseGridVM.EmptyStateSecondary {
        BrowseGridVM.emptyStateSecondary(.init(
            photosAuthNeeded: vm.photosAuthNeeded,
            photosAuthCanRequest: vm.photosAuthCanRequest,
            isLoading: vm.isLoading,
            hasLoadError: vm.loadError != nil,
            hasCurrentSource: vm.currentSource != nil
        ))
    }

    /// Open this app's own page in the system Settings / System Settings app,
    /// where the Photos toggle the user already declined can be flipped back
    /// on. The only in-app next step once the prompt is spent (#2454).
    private static func openAppSettings() {
        #if os(iOS)
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
        #elseif os(macOS)
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos"
        ) else { return }
        NSWorkspace.shared.open(url)
        #endif
    }

    /// The Photos-permission panel (#2454). One layout, two states: Connect
    /// raises the system prompt while the choice is still open; Open Settings
    /// takes over once it isn't, because iOS never re-shows a spent prompt.
    @ViewBuilder
    private func photosAuthPanel(canRequest: Bool, action: @escaping () -> Void) -> some View {
        VStack(spacing: 12) {
            Text(BrowseGridVM.photosAuthBody(canRequest: canRequest))
                .font(.system(size: 12))
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 380)
            Button(BrowseGridVM.photosAuthButtonTitle(canRequest: canRequest), action: action)
                .buttonStyle(.borderedProminent)
        }
        .accessibilityIdentifier("photos-auth-panel")
    }

    @ViewBuilder
    private var secondary: some View {
        switch secondaryCase {
        case .photosAuthConnect:
            photosAuthPanel(canRequest: true) { onGrantPhotosAccess?() }
                .disabled(onGrantPhotosAccess == nil)
        case .photosAuthSettings:
            photosAuthPanel(canRequest: false) { Self.openAppSettings() }
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading…")
                    .font(MapleTokens.Typography.rowLabel)
                    .foregroundStyle(MapleTokens.textMuted)
            }
        case .loadError:
            VStack(spacing: 6) {
                Text(vm.loadError?.localizedDescription ?? "")
                    .font(.system(size: 11))
                    .foregroundStyle(MapleTokens.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                Button("Retry") {
                    // Clear the error — the sidebar row-tap re-runs the load.
                    vm.loadError = nil
                }
                .buttonStyle(.bordered)
            }
        case .sourceHasNoRaws:
            Text("This folder has no supported RAW files.")
                .font(MapleTokens.Typography.rowLabel)
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
        case .noSourcePicked:
            Text("Pick a folder or Photos Library filter in the sidebar.")
                .font(MapleTokens.Typography.rowLabel)
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
        }
    }
}
