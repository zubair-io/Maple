// PhotoThumbnailCell.swift — shared thumbnail cell for all photo-grid surfaces.
//
// Part of the grid-unify refactor (#1490 M0). Owns:
//   - load lifecycle (.task + cancel on disappear via task cancellation)
//   - overlay rendering (badges from GridCellOverlays, selection outline)
//   - tap routing (closure, same pattern as BrowseGrid + CloudTimeline)
//   - zoom-transition source tag (iOS 18+ matchedTransitionSource seam)
//
// Overlay visuals are ported verbatim from the existing cells:
//   - phone pick-dot + ≥4★ gold   ← LibraryCell.phoneBadgeOverlay
//   - desktop FlagBadge + StarView ← LibraryCell.badgeOverlay(.desktop)
//   - cloud rating ★               ← CloudTimelineCell (rating top-leading)
//   - merged sync badge            ← CloudTimelineMergedCell.badgeView
//
// M1b additions (#1490):
//   - accessibilityIdentifier("thumb-\(item.displayName)") — restores the
//     UITest harness identifier that LibraryCell had (`asset.displayName`).
//   - multiSelectChecked — when non-nil, renders a top-trailing checkmark
//     badge (checked: white-on-accent; unchecked: white-on-scrim) and
//     suppresses the single-select outline. Matches BrowseGrid's original
//     multi-select chrome exactly.

import SwiftUI
import MapleCore

// MARK: - PhotoThumbnailCell

struct PhotoThumbnailCell: View {

    // MARK: Inputs

    let item: PhotoGridItem
    let provider: ThumbnailProvider
    let displayMode: GridDisplayMode

    var isSelected: Bool = false
    /// When non-nil, applies `.matchedTransitionSource(id:in:)` on iOS 18+
    /// using `item.id` as the tag. The zoom-open transition (#1489) adopts
    /// this seam in M1+. Setting this to `nil` is a no-op (no transition tag).
    var transitionNamespace: Namespace.ID? = nil
    /// Multi-select checked state. When non-nil the cell is in multi-select
    /// mode and renders a checkmark badge at top-trailing:
    ///   - `true`  — filled checkmark.circle.fill white-on-accent (selected)
    ///   - `false` — unfilled circle white-on-dark-scrim (unselected)
    /// Also suppresses the single-select outline so the two indicators don't
    /// conflict. When `nil` behaves as before (single-select outline only).
    var multiSelectChecked: Bool? = nil
    let onTap: () -> Void
    /// Fired from the cell's `.onAppear`. SwiftUI may call `.onAppear` more than
    /// once (re-insertion / scroll in-out), so the work MUST be idempotent — use
    /// it for session priming or page-load triggers, not exactly-once side effects.
    /// The thumbnail `.task(id:)` runs independently; this is a supplemental hook.
    var onAppear: (() -> Void)? = nil

    // MARK: State

    @State private var thumb: Data?

    /// Multi-select-aware accessibility label — restores the per-cell
    /// "<name>, selected / not selected" announcement BrowseGrid had before the
    /// shared-cell migration. Single-select mode announces just the name.
    private var accessibilityLabelText: String {
        guard let checked = multiSelectChecked else { return item.displayName }
        return "\(item.displayName), \(checked ? "selected" : "not selected")"
    }

    /// Selection hint, multi-select only. Empty (no hint) in single-select
    /// because the tap action is surface-specific (open vs. select), so only the
    /// universal multi-select select/deselect hint is asserted here.
    private var accessibilityHintText: String {
        guard let checked = multiSelectChecked else { return "" }
        return "Double tap to \(checked ? "deselect" : "select")"
    }

    // MARK: Body

    var body: some View {
        ThumbnailImage(jpegData: thumb, displayMode: displayMode)
            .overlay {
                GridCellOverlayView(overlays: item.overlays)
            }
            .overlay(alignment: .topTrailing) {
                // Multi-select badge — only present when multiSelectChecked is non-nil.
                if let checked = multiSelectChecked {
                    Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(checked ? .white : Color.white.opacity(0.90))
                        .background(
                            Circle()
                                .fill(checked ? Color.accentColor : Color.black.opacity(0.45))
                                .padding(-2)
                        )
                        .padding(6)
                        .accessibilityHidden(true)
                }
            }
            .modifier(ZoomSourceTag(id: item.id, namespace: transitionNamespace))
            .contentShape(Rectangle())
            .onTapGesture { onTap() }
            .onAppear { onAppear?() }
            // Accessibility: UITest harness resolves cells by displayName via
            // `app.otherElements["thumb-<displayName>"]` — mirrors LibraryCell's
            // `.accessibilityIdentifier("thumb-\(asset.displayName)")`.
            .accessibilityIdentifier("thumb-\(item.displayName)")
            .accessibilityLabel(accessibilityLabelText)
            .accessibilityHint(accessibilityHintText)
            .task(id: item.id) {
                let bytes = await provider.thumbnail(for: item.thumbnailSource)
                // Skip the assignment if the cell scrolled away mid-load, and
                // fade the thumbnail in — matches the original CloudTimelineCell.
                guard !Task.isCancelled else { return }
                withAnimation(.easeInOut(duration: 0.18)) {
                    thumb = bytes
                }
            }
    }
}

// MARK: - GridCellOverlayView

/// Renders badge overlays from `GridCellOverlays` data. Visual output is
/// byte-identical to the originals from LibraryCell, CloudTimelineCell, and
/// CloudTimelineMergedCell.
private struct GridCellOverlayView: View {
    let overlays: GridCellOverlays

    var body: some View {
        ZStack {
            // --- sync badge (merged timeline) — bottom-trailing ---
            if let sync = overlays.sync {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        syncBadge(for: sync)
                            .padding(4)
                    }
                }
            }

            // --- style-specific rating / flag badges ---
            switch overlays.style {
            case .phone:
                phoneBadges
            case .desktop:
                desktopBadges
            case .cloud:
                cloudBadges
            }
        }
    }

    // MARK: Phone badge layout (S2 spec)

    /// Green pick dot top-left (4pt inset), ≥4★ gold bottom-left (4pt inset).
    /// No reject badge in v0.1 per the spec.
    /// Matches `LibraryCell.phoneBadgeOverlay` exactly.
    @ViewBuilder
    private var phoneBadges: some View {
        let stars = overlays.rating
        let isPick = overlays.flag == .pick

        if isPick {
            ZStack(alignment: .topLeading) {
                Color.clear
                Circle()
                    .fill(MapleTokens.successText)
                    .frame(width: 6, height: 6)
                    .padding(4)
            }
        }

        if stars >= 4 {
            ZStack(alignment: .bottomLeading) {
                Color.clear
                HStack(spacing: 1) {
                    ForEach(0..<stars, id: \.self) { _ in
                        Image(systemName: "star.fill")
                            .font(.system(size: 6))
                            .foregroundStyle(MapleTokens.star)
                    }
                }
                .padding(4)
            }
        }
    }

    // MARK: Desktop badge layout (iPad / Mac)

    /// FlagBadge + StarView row at bottom-leading.
    /// Matches `LibraryCell.badgeOverlay(.desktop)` exactly.
    @ViewBuilder
    private var desktopBadges: some View {
        let stars = overlays.rating
        let flag = overlays.flag ?? .none

        // Cloud-timeline surfaces show star ratings at top-leading instead.
        // When there's a sync badge the surface is cloud/merged — use top-leading.
        // When no sync badge, it's the library/browse surface — use bottom-leading.
        if overlays.sync != nil {
            // Cloud surface: rating top-leading (matches CloudTimelineCell)
            if stars > 0 {
                ZStack(alignment: .topLeading) {
                    Color.clear
                    HStack(spacing: 1) {
                        ForEach(0..<stars, id: \.self) { _ in
                            Image(systemName: "star.fill")
                                .font(.caption2)
                        }
                    }
                    .foregroundStyle(.yellow)
                    .padding(4)
                }
            }
        } else {
            // Library / browse surface: FlagBadge + StarView bottom-leading
            if flag != .none || stars > 0 {
                ZStack(alignment: .bottomLeading) {
                    Color.clear
                    HStack(spacing: 2) {
                        if flag != .none {
                            FlagBadge(flag: flag)
                        }
                        if stars > 0 {
                            StarView(count: stars)
                        }
                    }
                    .padding(4)
                }
            }
        }
    }

    // MARK: Cloud badge layout (cloud-only timeline cells)

    /// Rating stars at top-leading, yellow, caption2 font. Used for cloud-only
    /// `SearchAsset` cells that have no sync badge (`sync == nil`) but still need
    /// the cloud-timeline star placement. Matches `CloudTimelineCell` exactly:
    /// `Image(systemName:"star.fill").font(.caption2).foregroundStyle(.yellow)`,
    /// 4pt padding, top-leading alignment.
    @ViewBuilder
    private var cloudBadges: some View {
        let stars = overlays.rating
        if stars > 0 {
            ZStack(alignment: .topLeading) {
                Color.clear
                HStack(spacing: 1) {
                    ForEach(0..<stars, id: \.self) { _ in
                        Image(systemName: "star.fill")
                            .font(.caption2)
                    }
                }
                .foregroundStyle(.yellow)
                .padding(4)
            }
        }
    }

    // MARK: Sync badge

    /// Sync badge icon — matches `CloudTimelineMergedCell.badgeView` exactly.
    @ViewBuilder
    private func syncBadge(for sync: SyncBadge) -> some View {
        switch sync {
        case .synced:
            Image(systemName: "checkmark.icloud.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .shadow(radius: 1)
        case .cloudOnly:
            Image(systemName: "icloud.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .shadow(radius: 1)
        case .localOnly:
            // Pending-upload state is implied. No badge (matches
            // CloudTimelineMergedCell.badgeView .localOnly → EmptyView).
            EmptyView()
        }
    }
}

// MARK: - ZoomSourceTag

/// Applies `.matchedTransitionSource(id:in:)` on iOS 18+ when a namespace is
/// provided. A no-op on older OS and when namespace is nil. The zoom-open
/// transition (#1489) adopts this seam in M1+.
private struct ZoomSourceTag: ViewModifier {
    let id: String
    let namespace: Namespace.ID?

    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *), let ns = namespace {
            content.matchedTransitionSource(id: id, in: ns)
        } else {
            content
        }
    }
}

// MARK: - Previews

#Preview("Phone — pick + 4★ selected") {
    let overlays = GridCellOverlays(rating: 4, flag: .pick, sync: nil, style: .phone)
    let item = PhotoGridItem(id: "p1", displayName: "IMG_0001.dng",
                             thumbnailSource: .photoKit(localID: "x"), overlays: overlays)
    PhotoThumbnailCell(
        item: item,
        provider: .preview(),
        displayMode: .fill,
        isSelected: true,
        onTap: {}
    )
    .frame(width: 120, height: 120)
    .padding()
    .background(MapleTokens.bg)
}

#Preview("Desktop — reject + 3★") {
    let overlays = GridCellOverlays(rating: 3, flag: .reject, sync: nil, style: .desktop)
    let item = PhotoGridItem(id: "d1", displayName: "IMG_0002.dng",
                             thumbnailSource: .photoKit(localID: "y"), overlays: overlays)
    PhotoThumbnailCell(
        item: item,
        provider: .preview(),
        displayMode: .fill,
        isSelected: false,
        onTap: {}
    )
    .frame(width: 180, height: 180)
    .padding()
    .background(MapleTokens.bg)
}

#Preview("Cloud — synced badge + 5★") {
    let overlays = GridCellOverlays(rating: 5, flag: nil, sync: .synced, style: .desktop)
    let item = PhotoGridItem(
        id: "c1",
        displayName: "cloud.dng",
        thumbnailSource: .cloud(absPath: "/photos/a.dng", host: "srv"),
        overlays: overlays
    )
    PhotoThumbnailCell(
        item: item,
        provider: .preview(),
        displayMode: .fill,
        isSelected: false,
        onTap: {}
    )
    .frame(width: 140, height: 140)
    .padding()
    .background(MapleTokens.bg)
}

#Preview("Multi-select — checked") {
    let overlays = GridCellOverlays(rating: 0, flag: nil, style: .desktop)
    let item = PhotoGridItem(id: "ms1", displayName: "IMG_0010.dng",
                             thumbnailSource: .photoKit(localID: "z"), overlays: overlays)
    PhotoThumbnailCell(
        item: item,
        provider: .preview(),
        displayMode: .fill,
        isSelected: true,
        multiSelectChecked: true,
        onTap: {}
    )
    .frame(width: 180, height: 180)
    .padding()
    .background(MapleTokens.bg)
}

#Preview("Multi-select — unchecked") {
    let overlays = GridCellOverlays(rating: 0, flag: nil, style: .desktop)
    let item = PhotoGridItem(id: "ms2", displayName: "IMG_0011.dng",
                             thumbnailSource: .photoKit(localID: "w"), overlays: overlays)
    PhotoThumbnailCell(
        item: item,
        provider: .preview(),
        displayMode: .fill,
        isSelected: false,
        multiSelectChecked: false,
        onTap: {}
    )
    .frame(width: 180, height: 180)
    .padding()
    .background(MapleTokens.bg)
}
