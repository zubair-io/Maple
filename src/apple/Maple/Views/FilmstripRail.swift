// FilmstripRail.swift — Pro Editor Canvas-first (A2, #1555).
//
// Floating glass filmstrip rail on the leading edge of the canvas-first
// editor (regular size class only).  A content-height glass panel — a
// vertical scroll of landscape thumbnails, no header — that the editor
// centers vertically (it does NOT span the
// full height; the panel caps its thumb-scroll area so few photos render a
// short, centered rail).  Mirrors the web `editor-filmstrip` 110px rail
// (vertically centered, `max-h` cap, collapse toggle).
//
// Collapse behaviour (updated in #feat/pro-editor-control-variants):
//   • COLLAPSED: the rail slides fully off the left edge via `.offset(x:)`,
//     leaving only a small tab button at the leading edge — just a chevron.
//   • EXPANDED: the rail slides back in.
//   • The chevron flips: `chevron.left` (collapse) when open,
//     `chevron.right` (expand) when closed.
//   • Animated with `easeInOut(duration: 0.25)` on the offset.
//   • The tab button stays at z=above the canvas so it never disappears.
//
// Thumbnail-loading path matches the horizontal `FilmstripView`: lazy load
// on appear, cancel the in-flight Task on disappear, memoise by asset id.

import SwiftUI
import MapleCore

struct FilmstripRail: View {
    let assets: [AssetRef]
    let activeID: AssetRef.ID?
    /// Source the assets came from — forwarded to `ThumbnailLoader` so the
    /// sourceless thumb path (cloud / PhotoKit / self-hosted) can resolve.
    var source: (any ImageSource)? = nil
    let onSelect: (AssetRef) -> Void

    @State private var collapsed = false

    private let railWidth: CGFloat = 110
    private let tabWidth: CGFloat = 20   // width of the collapse-tab button
    private let thumbSpacing: CGFloat = 6
    /// Max height of the thumb-scroll area; beyond this the strip scrolls.
    private let scrollCap: CGFloat = 460

    private var thumbWidth: CGFloat { railWidth - 16 }
    private var thumbHeight: CGFloat { (thumbWidth * 2 / 3).rounded() } // 3:2 landscape
    private var contentHeight: CGFloat {
        // n thumbnails have only (n-1) inter-thumb gaps — the last carries no
        // trailing spacing, so the rail hugs the thumbs exactly when few.
        let n = CGFloat(assets.count)
        return n > 0 ? n * thumbHeight + (n - 1) * thumbSpacing : 0
    }

    var body: some View {
        ZStack(alignment: .leading) {
            // ── Rail panel (slides off-screen when collapsed) ──────────────
            filmstripPanel
                // Slide off to the LEFT by the full rail width + its horizontal
                // padding (12pt from EditorView) when collapsed.  The tab button
                // (below) stays visible and handles expand.
                .offset(x: collapsed ? -(railWidth + 12) : 0)
                .animation(.easeInOut(duration: 0.25), value: collapsed)
                // Hide from a11y while slid off — VoiceOver should not reach
                // thumb cells that are visually off-screen.
                .accessibilityHidden(collapsed)

            // ── Collapse / expand tab button ──────────────────────────────
            // Always on-screen; floats at the leading edge.  When collapsed it
            // is the only visible affordance for the filmstrip.
            collapseTab
        }
        .accessibilityIdentifier("editor-filmstrip-rail")
    }

    // MARK: - Rail panel

    private var filmstripPanel: some View {
        // No header — the only collapse affordance is the edge tab (below).
        VStack(spacing: 8) {
            // Only mount the thumb scroll while expanded — a collapsed rail is
            // slid off-screen, so keeping the cells alive would pointlessly
            // `onAppear`/load thumbnails while hidden (Copilot #1680).
            if !collapsed {
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(spacing: thumbSpacing) {
                        ForEach(assets, id: \.id) { asset in
                            FilmstripRailCell(
                                asset: asset,
                                isActive: asset.id == activeID,
                                width: thumbWidth,
                                height: thumbHeight,
                                source: source,
                                onSelect: onSelect
                            )
                        }
                    }
                    .padding(.bottom, 2)
                }
                // Content-height up to the cap: the scroll area hugs the
                // thumbnails when there are few, scrolls when there are many.
                .frame(height: min(contentHeight, scrollCap))
            }
        }
        .padding(8)
        .frame(width: railWidth)
        .background(
            ProTokens.bg.opacity(ProGlass.opacity),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
    }

    // MARK: - Collapse/expand tab

    /// Small chevron pill pinned at the leading edge.  When the rail is
    /// expanded it partially overlaps the rail; when collapsed it is the
    /// only filmstrip affordance.
    private var collapseTab: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.25)) { collapsed.toggle() }
        } label: {
            Image(systemName: collapsed ? "chevron.right" : "chevron.left")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ProTokens.textMuted)
                .frame(width: tabWidth, height: 36)
                .background(
                    ProTokens.bg.opacity(ProGlass.opacity),
                    in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(collapsed ? "Expand filmstrip" : "Collapse filmstrip")
        .accessibilityIdentifier("editor-filmstrip-tab")
        // The tab sits at the leading edge of the ZStack.  When the rail is
        // visible, offset the tab to sit just past the right edge of the rail
        // so it peeks out without covering thumbs.
        .offset(x: collapsed ? 0 : railWidth + 2)
        .animation(.easeInOut(duration: 0.25), value: collapsed)
    }
}

// MARK: - FilmstripRailCell

private struct FilmstripRailCell: View {
    let asset: AssetRef
    let isActive: Bool
    let width: CGFloat
    let height: CGFloat
    let source: (any ImageSource)?
    let onSelect: (AssetRef) -> Void

    /// Decoded thumbnail bitmap, produced off the main actor (never in `body`).
    @State private var decoded: CGImage?
    @State private var loadTask: Task<Void, Never>?
    @State private var loadedForID: AssetRef.ID?

    var body: some View {
        Button {
            onSelect(asset)
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 5)
                    .fill(ProTokens.panel)

                if let decoded {
                    Image(decorative: decoded, scale: 1)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                }

                if isActive {
                    RoundedRectangle(cornerRadius: 5)
                        .strokeBorder(ProTokens.accent, lineWidth: 2)
                }
            }
            .frame(width: width, height: height)
            .clipShape(RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(asset.displayName)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .onAppear { startLoad() }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
        }
    }

    private func startLoad() {
        if loadedForID == asset.id, decoded != nil { return }
        guard loadTask == nil else { return }
        let capturedAsset = asset
        let capturedSource = source
        loadTask = Task { @MainActor in
            let bytes = await ThumbnailLoader.shared.load(
                for: capturedAsset, from: capturedSource
            )
            guard !Task.isCancelled else { return }
            // Decode off the main actor before touching view state — never in
            // `body`. Keyed on the asset's stable id; no arrival fade (it
            // hitches scroll the same way it does in the grid).
            let image = await ThumbnailDecoder.image(
                for: bytes, key: capturedAsset.stableID ?? capturedAsset.id.uuidString)
            guard !Task.isCancelled else { return }
            decoded = image
            loadedForID = capturedAsset.id
            loadTask = nil
        }
    }
}
