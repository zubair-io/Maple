// PreviewHero.swift — the iPhone Photos-style open / close between a grid
// tile and the fullscreen Preview, hand-rolled.
//
// SwiftUI's `.navigationTransition(.zoom)` runs on the iOS 26.4 simulator
// but never attached on an iOS 27 device (the push landed with no zoom and
// no interactive dismissal), and a NavigationStack push hides the grid
// beneath the destination anyway, so a fading backdrop could never reveal
// the tiles. This overlay lives ABOVE the Library tab's stack with the grid
// live underneath, and owns the whole motion:
//
//   open   — a still of the tapped tile's bitmap springs from the tile's
//            live frame to the photo's fit rect while the backdrop darkens
//            and, at the end, the real Preview fades in on top; the still
//            starts cropped exactly as the tile is and uncrops on the way.
//   close  — the real Preview's pull-down (`PreviewView` owns the drag)
//            commits by handing over to the same still, which springs from
//            the pager's current photo rect back into the CURRENT photo's
//            tile (the grid scrolled it into view while covered), while the
//            backdrop clears.
//
// `libraryPath` still carries `.preview(asset)` (Edit pushes `.edit` on
// top of it, deep links seed it, the drawer gates on it) — the stack's
// `.preview` destination is just an invisible placeholder now.

#if os(iOS)

import SwiftUI
import MapleCore

/// Everything the hero needs about the photo being opened.
struct PreviewHeroSubject: Equatable {
    let asset: AssetRef
    /// The tile's bitmap — the same one the grid cell draws — so the hero
    /// starts pixel-identical to the tile and never pops in.
    let image: CGImage?

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.asset.id == rhs.asset.id && lhs.image === rhs.image
    }

    var key: String { asset.stableID ?? asset.id.uuidString }
    var imageSize: CGSize {
        guard let image else { return CGSize(width: 1, height: 1) }
        return CGSize(width: image.width, height: image.height)
    }
}

/// Where the hero is in its life. The still is on screen for `.opening`
/// and `.closing`; Preview is interactive for `.open`.
enum PreviewHeroPhase: Equatable {
    case opening
    case open
    case closing
}

struct PreviewHero<Content: View>: View {
    let subject: PreviewHeroSubject
    /// Live window-space frame of the subject's tile (the grid publishes
    /// it for the selected photo). Nil until the grid has laid it out.
    let tileFrame: CGRect?
    /// Corner radius the tile is drawn with.
    let tileCornerRadius: CGFloat
    /// The fullscreen Preview, shown once the open completes and kept
    /// through the close (it fades under the still).
    @ViewBuilder let content: () -> Content
    /// The close finished — remove the hero and pop the path.
    let onClosed: () -> Void

    /// Set by the content (Preview's pull-down commit) to start the close;
    /// the hero reads the still's current rect from it.
    @Binding var closeRequest: PreviewHeroCloseRequest?

    @State private var phase: PreviewHeroPhase = .opening
    /// 0 = at the tile, 1 = at the fit rect.
    @State private var progress: CGFloat = 0
    /// Where the close starts from: the pager's current photo rect.
    @State private var closeStart: CGRect?

    /// Reports each phase change so the host can blank the source tile
    /// while the photo is in flight.
    var onPhaseChange: (PreviewHeroPhase) -> Void = { _ in }

    var body: some View {
        GeometryReader { geometry in
            // The overlay ignores the safe areas, so `bounds` is window
            // space — the same space `tileFrame` (a `.global` frame) and the
            // pager's `photoRectInWindow` use.
            let bounds = CGRect(origin: .zero, size: geometry.size)
            let fit = PreviewViewVM.fitRect(imageSize: subject.imageSize, in: bounds)
            // Without a tile (a Timeline / deep-link push with no grid tile
            // on screen) grow from the centre; it still reads as an open.
            let tile = tileFrame ?? CGRect(x: bounds.midX - 40, y: bounds.midY - 40, width: 80, height: 80)
            let start = phase == .closing ? (closeStart ?? fit) : fit
            let rect = PreviewViewVM.heroRect(from: tile, to: start, progress: progress)

            ZStack {
                MapleTokens.bg
                    .opacity(Double(progress) * PreviewHeroMotion.dimAtOpen)

                // Preview is a normal full-screen view: it handles its own
                // safe areas (header pill under the status bar, action bar
                // above the home indicator) exactly as it did when pushed.
                // It fades in over the tail of the open and is gone the
                // instant a close starts — the still is the photo from then
                // on; two copies would show the hand-over.
                content()
                    .opacity(phase == .open ? 1 : (phase == .closing ? 0 : contentOpacity))
                    .allowsHitTesting(phase == .open)

                if phase != .open {
                    heroStill(in: rect, progress: progress)
                }
            }
        }
        .ignoresSafeArea()
        .onAppear {
            onPhaseChange(.opening)
            withAnimation(PreviewHeroMotion.openSpring, completionCriteria: .logicallyComplete) {
                progress = 1
            } completion: {
                phase = .open
                onPhaseChange(.open)
            }
        }
        .onChange(of: closeRequest) { _, request in
            guard let request, phase == .open else { return }
            closeStart = request.fromRect ?? nil
            // Land in one non-animated step at the start rect, then spring
            // to the tile: `progress` reads against `closeStart` from here.
            var snap = Transaction()
            snap.disablesAnimations = true
            withTransaction(snap) {
                phase = .closing
                progress = 1
            }
            onPhaseChange(.closing)
            withAnimation(PreviewHeroMotion.closeSpring, completionCriteria: .logicallyComplete) {
                progress = 0
            } completion: {
                onClosed()
            }
        }
    }

    private var contentOpacity: Double {
        Double(min(1, max(0, (progress - PreviewHeroMotion.contentFadeStart) / (1 - PreviewHeroMotion.contentFadeStart))))
    }

    /// The still: the tile's bitmap, filled into a frame that blends from
    /// the tile to the fit rect. The frame's aspect walks from the tile's
    /// to the photo's, so `.fill` uncrops continuously — the tile's centre
    /// crop at 0, the whole photo at 1.
    private func heroStill(in rect: CGRect, progress: CGFloat) -> some View {
        Group {
            if let image = subject.image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Rectangle().fill(MapleTokens.surfaceAlt)
            }
        }
        .frame(width: rect.width, height: rect.height)
        .clipShape(RoundedRectangle(
            cornerRadius: PreviewViewVM.heroCornerRadius(progress: progress, tileRadius: tileCornerRadius)))
        .position(x: rect.midX, y: rect.midY)
        .allowsHitTesting(false)
    }
}

/// The hero's springs and fade points (outside the generic view, which
/// cannot hold static storage).
enum PreviewHeroMotion {
    static let openSpring = Animation.spring(response: 0.46, dampingFraction: 0.86)
    static let closeSpring = Animation.spring(response: 0.42, dampingFraction: 0.9)
    /// Preview fades in over the tail of the open so the still is never
    /// visibly replaced.
    static let contentFadeStart: CGFloat = 0.7
    /// The grid stays faintly visible beneath a fully open Preview, as in
    /// Photos.
    static let dimAtOpen: Double = 0.92
}

/// A close, as requested by the content: where its photo currently is
/// (nil — the back button — shrinks from the fit rect).
struct PreviewHeroCloseRequest: Equatable {
    let fromRect: CGRect?
}

#endif
