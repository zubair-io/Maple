// LibraryCell.swift — shared thumbnail cell for the Library grids
// (responsive-program S2, #623).
//
// Extracted from `BrowseGrid.swift`'s `ThumbnailCell`. Renders one
// asset's thumbnail inside a square 1:1 frame with rounded corners,
// loads the thumbnail data lazily on appear, cancels in-flight tasks
// on disappear, and overlays culling badges + a selection outline.
//
// Two badge styles are supported:
//
//   * `.desktop` — the existing chrome: a `FlagBadge` (pick / reject /
//     none) + `StarView` (0..5) row, anchored bottom-leading. Used by
//     `BrowseGrid` on iPad / Mac so the desktop look is unchanged.
//
//   * `.phone` — the responsive-program S2 phone style: a 6pt green
//     pick dot at top-left (4pt inset) when the asset is flagged
//     `.pick`, and 6pt gold star glyphs (≥4★ only) at bottom-left
//     (4pt inset). No reject badge in v0.1 per the spec.
//
// Behavioural contract preserved from `ThumbnailCell`:
//   - lazy thumbnail load via `ThumbnailLoader.shared.load(...)`
//   - in-flight Task cancellation on `.onDisappear`
//   - per-id memoisation so cell recycling doesn't re-load
//   - `accessibilityIdentifier("thumb-\(displayName)")` (UITest harness)

import SwiftUI
import MapleCore

/// Visual style of the badge overlay. Pick one per call-site.
enum LibraryCellStyle {
    /// Existing iPad / Mac chrome: FlagBadge + StarView row in bottom-leading.
    case desktop
    /// Responsive-program S2 phone style: green pick dot top-left, ≥4★ bottom-left.
    case phone
}

struct LibraryCell: View {
    let asset: AssetRef
    let isSelected: Bool
    let session: EditSession?
    /// The source the asset came from. Used by sourceless assets
    /// (PhotoKit, SelfHosted) so `ThumbnailLoader` can fall back to the
    /// source's thumb path before issuing a full RAW decode.
    let source: (any ImageSource)?
    /// fill / fit. Cell shape is always 1:1; only the image's content
    /// mode changes.
    let displayMode: GridDisplayMode
    /// Badge layout — see `LibraryCellStyle`.
    let style: LibraryCellStyle

    init(
        asset: AssetRef,
        isSelected: Bool,
        session: EditSession?,
        source: (any ImageSource)?,
        displayMode: GridDisplayMode,
        style: LibraryCellStyle = .desktop
    ) {
        self.asset = asset
        self.isSelected = isSelected
        self.session = session
        self.source = source
        self.displayMode = displayMode
        self.style = style
    }

    /// JPEG bytes from `ThumbnailLoader`. `nil` while the cell is
    /// loading or the render failed; in both cases we keep the
    /// placeholder visible.
    @State private var thumbData: Data?
    /// In-flight load task — cancelled on `.onDisappear` so scrolling
    /// past a large folder doesn't queue up thousands of decodes.
    @State private var loadTask: Task<Void, Never>?
    /// Memoise the asset id we last loaded for, so cells reused via
    /// SwiftUI's recycle pool don't re-render the same thumb when they
    /// re-appear.
    @State private var loadedForID: AssetRef.ID?

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            ThumbnailImage(jpegData: thumbData, displayMode: displayMode)

            // Style-specific badge overlay. The desktop style preserves
            // the FlagBadge + StarView row used by the iPad / Mac grids
            // for backward visual compat; the phone style follows the
            // S2 spec (pick dot top-left, stars bottom-left if ≥4).
            badgeOverlay
        }
        .overlay {
            if isSelected {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(MapleTokens.primary, lineWidth: 2)
            }
        }
        // UITest harness selector. `app.otherElements["thumb-test_0017"]`
        // resolves the cell containing the asset whose displayName is
        // `test_0017`. See .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md.
        .accessibilityIdentifier("thumb-\(asset.displayName)")
        .onAppear { startLoad() }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
        }
    }

    // MARK: - Badge overlay

    @ViewBuilder
    private var badgeOverlay: some View {
        switch style {
        case .desktop:
            if let session {
                HStack(spacing: 2) {
                    FlagBadge(flag: session.culling.flag)
                    if session.culling.stars > 0 {
                        StarView(count: session.culling.stars)
                    }
                }
                .padding(4)
            }
        case .phone:
            phoneBadgeOverlay
        }
    }

    /// S2 phone badge layout: pick dot top-left (4pt inset), ≥4★ stars
    /// bottom-left (4pt inset). Two overlay layers because the dot and
    /// stars sit on different edges of the same cell — modeled as two
    /// `topLeading` / `bottomLeading` overlays to avoid an extra ZStack.
    @ViewBuilder
    private var phoneBadgeOverlay: some View {
        let stars = session?.culling.stars ?? 0
        let isPick = session?.culling.flag == .pick

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

    // MARK: - Loading

    private func startLoad() {
        // Memoised: if we've already produced bytes for this exact
        // asset id, don't re-queue when the cell scrolls back into view.
        if loadedForID == asset.id, thumbData != nil { return }
        guard loadTask == nil else { return }
        let capturedAsset = asset
        let capturedSource = source
        loadTask = Task { @MainActor in
            let data = await ThumbnailLoader.shared.load(
                for: capturedAsset, from: capturedSource
            )
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.18)) {
                thumbData = data
                loadedForID = capturedAsset.id
            }
            loadTask = nil
        }
    }
}

#Preview("Desktop style — pick + 3 stars") {
    LibraryCell(
        asset: AssetRef.preview(),
        isSelected: false,
        session: nil,
        source: nil,
        displayMode: .fill,
        style: .desktop
    )
    .frame(width: 180, height: 180)
    .padding()
    .background(MapleTokens.bg)
}

#Preview("Phone style — selected") {
    LibraryCell(
        asset: AssetRef.preview(),
        isSelected: true,
        session: nil,
        source: nil,
        displayMode: .fill,
        style: .phone
    )
    .frame(width: 120, height: 120)
    .padding()
    .background(MapleTokens.bg)
}
