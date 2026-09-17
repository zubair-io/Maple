#if os(iOS)
import SwiftUI
import MapleCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

// MARK: - UIKit preview pager

/// A page controller that does not expose UIKit's 50%-crossing selection as a
/// SwiftUI binding. `TabView(selection:)` rewrites that binding every time a
/// scrub crosses the midpoint, causing SwiftUI to reconcile the whole Preview
/// repeatedly. This wrapper publishes only after UIKit reports a completed
/// transition, so midpoint scrubbing remains entirely inside UIKit.
///
/// Gestures on a page, and who owns them:
///   • pinch                → the page's `UIScrollView` zoom; at fit zoom a
///                            pinch-in is the system zoom transition's own
///                            pinch-to-dismiss (`PreviewDestination`)
///   • horizontal pan       → this pager's page scroll
///   • vertical pull-down   → the system zoom transition's own interactive
///                            dismissal (`PreviewDestination`), which shrinks
///                            the still back into its grid tile with the grid
///                            visible beneath. UIKit only lets that pan begin
///                            when no scroll view under the finger claims it,
///                            and this pager's horizontal page scroll claims
///                            EVERY pan — so `pullGate` below exists purely to
///                            arbitrate: it recognises a downward,
///                            vertical-dominant start at fit zoom and does
///                            nothing with it, but the page scroll is made to
///                            wait for it (`require(toFail:)`), so a pull is
///                            left to the system dismissal while a horizontal
///                            start fails the gate at once and pages as before.
struct PreviewPager: UIViewControllerRepresentable {
    let asset: AssetRef
    let assets: [AssetRef]
    let source: (any ImageSource)?
    let provider: ThumbnailProvider
    /// See `PreviewView.transitionProgress` — forwarded to every page so the
    /// still is cropped like its tile while the zoom is tile-sized.
    let transitionProgress: CGFloat
    let onSelectAsset: (AssetRef) -> Void
    /// Fires with `true` the moment a pull-down is recognised (the system
    /// dismissal is now dragging the whole view as a card) and `false` when
    /// the finger lifts — whether the dismissal then commits or springs
    /// back. UIKit scales the card rather than resizing it, so this is the
    /// only signal `PreviewView` has to fade its chrome during the drag.
    let onPullActiveChanged: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> UIPageViewController {
        let pager = UIPageViewController(
            transitionStyle: .scroll,
            navigationOrientation: .horizontal
        )
        pager.view.backgroundColor = UIColor(MapleTokens.bg)
        context.coordinator.configure(
            assets: assets,
            source: source,
            provider: provider,
            onSelectAsset: onSelectAsset,
            onPullActiveChanged: onPullActiveChanged
        )
        let pullGate = PullDownGateRecognizer(target: context.coordinator, action: #selector(Coordinator.pullChanged(_:)))
        pullGate.maximumNumberOfTouches = 1
        pullGate.delegate = context.coordinator
        pullGate.isPullAllowed = { [weak coordinator = context.coordinator] in
            coordinator?.visibleIsAtFitZoom ?? false
        }
        pager.view.addGestureRecognizer(pullGate)
        context.coordinator.pullGate = pullGate
        // The page scroll waits for the pull-down to be ruled out. A
        // horizontal-dominant start fails the gate immediately (see
        // `gestureRecognizerShouldBegin`), so paging is not perceptibly
        // delayed; a downward start wins the touch and leaves it to the
        // system dismissal.
        for scrollView in pager.view.subviews.compactMap({ $0 as? UIScrollView }) {
            scrollView.panGestureRecognizer.require(toFail: pullGate)
        }
        context.coordinator.pager = pager
        pager.dataSource = context.coordinator
        pager.delegate = context.coordinator
        if let initial = context.coordinator.controller(for: asset.id) {
            pager.setViewControllers([initial], direction: .forward, animated: false)
            initial.setTransitionProgress(transitionProgress)
            initial.setRefinementActive(true)
            context.coordinator.prune(around: asset.id)
        }
        return pager
    }

    func updateUIViewController(_ pager: UIPageViewController, context: Context) {
        context.coordinator.configure(
            assets: assets,
            source: source,
            provider: provider,
            onSelectAsset: onSelectAsset,
            onPullActiveChanged: onPullActiveChanged
        )
        context.coordinator.setTransitionProgress(transitionProgress)
        guard let target = context.coordinator.controller(for: asset.id),
              pager.viewControllers?.first !== target else { return }
        pager.setViewControllers([target], direction: .forward, animated: false)
        context.coordinator.prune(around: asset.id)
    }

    @MainActor
    final class Coordinator: NSObject, UIPageViewControllerDataSource, UIPageViewControllerDelegate,
        UIGestureRecognizerDelegate {
        private var assets: [AssetRef] = []
        private var assetIndexByID: [AssetRef.ID: Int] = [:]
        private var assetFingerprint = AssetFingerprint.empty
        /// Lazily materialized page window. Never build one hosting controller
        /// per asset: "All Photos" can contain tens of thousands of items.
        private var controllers: [Int: PreviewZoomController] = [:]
        private var controllerIndices: [ObjectIdentifier: Int] = [:]
        private var source: (any ImageSource)?
        private var provider: ThumbnailProvider?
        private var onSelectAsset: ((AssetRef) -> Void)?
        private var onPullActiveChanged: ((Bool) -> Void)?
        private var transitionProgress: CGFloat = 1
        weak var pager: UIPageViewController?
        weak var pullGate: UIPanGestureRecognizer?

        private struct AssetFingerprint: Equatable {
            let count: Int
            let firstID: AssetRef.ID?
            let lastID: AssetRef.ID?

            static let empty = AssetFingerprint(count: 0, firstID: nil, lastID: nil)

            init(_ assets: [AssetRef]) {
                count = assets.count
                firstID = assets.first?.id
                lastID = assets.last?.id
            }

            private init(count: Int, firstID: AssetRef.ID?, lastID: AssetRef.ID?) {
                self.count = count
                self.firstID = firstID
                self.lastID = lastID
            }
        }

        func configure(
            assets: [AssetRef],
            source: (any ImageSource)?,
            provider: ThumbnailProvider,
            onSelectAsset: @escaping (AssetRef) -> Void,
            onPullActiveChanged: @escaping (Bool) -> Void
        ) {
            self.onSelectAsset = onSelectAsset
            self.onPullActiveChanged = onPullActiveChanged
            // A page captures its `ThumbnailSource` (and so the ambient
            // `ImageSource`) when it is built. A source that arrives AFTER the
            // first page was built — the Search tab sets it in the same tap
            // that pushes Preview, so the first render can see the previous
            // value — would otherwise leave that page on the sourceless path:
            // a whole-RAW download for its thumbnail and no display tier
            // (#3551). Treat a change of source identity like a change of
            // asset list: rebuild the page window.
            let sourceChanged = (source as AnyObject?) !== (self.source as AnyObject?)
            self.source = source
            self.provider = provider
            let fingerprint = AssetFingerprint(assets)
            guard fingerprint != assetFingerprint || sourceChanged else { return }
            assetFingerprint = fingerprint
            self.assets = assets
            assetIndexByID = Dictionary(
                uniqueKeysWithValues: assets.enumerated().map { ($1.id, $0) }
            )
            controllers.removeAll(keepingCapacity: true)
            controllerIndices.removeAll(keepingCapacity: true)
        }

        /// Fan the zoom's progress out to every materialised page (the
        /// visible one and its wrapped neighbours) — cheap, and it keeps a
        /// neighbour that scrolls in mid-transition consistent.
        func setTransitionProgress(_ progress: CGFloat) {
            guard progress != transitionProgress else { return }
            transitionProgress = progress
            for controller in controllers.values {
                controller.setTransitionProgress(progress)
            }
        }

        // MARK: Pull-down arbitration

        /// The gate recognises a pull only to keep the page scroll out of
        /// its way and to report that a pull is in hand; the system
        /// dismissal reads the touch itself.
        /// Zoomed in, a vertical pan is the image pan — never a pull.
        var visibleIsAtFitZoom: Bool {
            (pager?.viewControllers?.first as? PreviewZoomController)?.isAtFitZoom ?? false
        }

        @objc func pullChanged(_ recognizer: UIPanGestureRecognizer) {
            switch recognizer.state {
            case .began:
                onPullActiveChanged?(true)
            case .ended, .cancelled, .failed:
                onPullActiveChanged?(false)
            default:
                break
            }
        }

        /// The system's interactive dismissal must see the same touch.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool { gestureRecognizer === pullGate }

        func controller(for id: AssetRef.ID) -> PreviewZoomController? {
            guard let index = assetIndexByID[id] else { return nil }
            return controller(at: index)
        }

        private func controller(at index: Int) -> PreviewZoomController? {
            guard assets.indices.contains(index), let provider else { return nil }
            if let existing = controllers[index] { return existing }
            let item = assets[index]
            let controller = PreviewZoomController(
                assetID: item.id,
                // The grid cell's decoded tile is cached under the same key
                // `PhotoGridItem(local:)` uses, so the page can paint it on its
                // very first frame — the zoom never grows an empty page.
                seedKey: item.stableID ?? item.id.uuidString,
                source: PreviewViewVM.thumbnailSource(for: item, source: source),
                provider: provider
            )
            controller.setTransitionProgress(transitionProgress)
            controllers[index] = controller
            controllerIndices[ObjectIdentifier(controller)] = index
            return controller
        }

        private func index(of controller: UIViewController) -> Int? {
            controllerIndices[ObjectIdentifier(controller)]
        }

        /// Retain only the visible page and its immediate wrapped neighbors.
        /// UIKit may ask for both neighbors during an interactive scrub; three
        /// controllers are sufficient regardless of library size.
        func prune(around id: AssetRef.ID) {
            guard assets.count > 1,
                  let index = assetIndexByID[id] else { return }
            let keep = Set([
                index,
                (index - 1 + assets.count) % assets.count,
                (index + 1) % assets.count
            ])
            for cachedIndex in Array(controllers.keys) where !keep.contains(cachedIndex) {
                if let removed = controllers.removeValue(forKey: cachedIndex) {
                    controllerIndices.removeValue(forKey: ObjectIdentifier(removed))
                }
            }
        }

        func pageViewController(
            _ pageViewController: UIPageViewController,
            viewControllerBefore viewController: UIViewController
        ) -> UIViewController? {
            guard assets.count > 1, let index = index(of: viewController) else { return nil }
            return controller(at: (index - 1 + assets.count) % assets.count)
        }

        func pageViewController(
            _ pageViewController: UIPageViewController,
            viewControllerAfter viewController: UIViewController
        ) -> UIViewController? {
            guard assets.count > 1, let index = index(of: viewController) else { return nil }
            return controller(at: (index + 1) % assets.count)
        }

        func pageViewController(
            _ pageViewController: UIPageViewController,
            didFinishAnimating finished: Bool,
            previousViewControllers: [UIViewController],
            transitionCompleted completed: Bool
        ) {
            guard finished else { return }
            if !completed {
                (pageViewController.viewControllers?.first as? PreviewZoomController)?
                    .setRefinementActive(true)
                return
            }
            guard let visible = pageViewController.viewControllers?.first,
                  let index = index(of: visible) else { return }
            let selected = assets[index]
            prune(around: selected.id)
            (visible as? PreviewZoomController)?.setRefinementActive(true)
            onSelectAsset?(selected)
        }

        func pageViewController(
            _ pageViewController: UIPageViewController,
            willTransitionTo pendingViewControllers: [UIViewController]
        ) {
            (pageViewController.viewControllers?.first as? PreviewZoomController)?
                .setRefinementActive(false)
        }
    }
}
// MARK: - PullDownGateRecognizer

/// A pan that decides, once, on the first 10pt of travel whether the touch
/// is a pull-down — and FAILS outright when it is not, so the page scroll
/// that waits on it (`require(toFail:)`) proceeds with no perceptible delay.
/// Deciding in the recognizer's own touch handling (rather than in
/// `gestureRecognizerShouldBegin`) is what makes the decision robust: UIKit
/// may ask a delegate to begin a pan after only a point or two of movement,
/// which is not enough to tell a pull from a page swipe.
private final class PullDownGateRecognizer: UIPanGestureRecognizer {
    /// Whether a pull may begin right now (false while the still is zoomed
    /// in — a vertical pan is then the image pan).
    var isPullAllowed: () -> Bool = { true }
    private var start: CGPoint?
    private var decided = false

    override func reset() {
        super.reset()
        start = nil
        decided = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if start == nil, let touch = touches.first {
            start = touch.location(in: view)
        }
        super.touchesBegan(touches, with: event)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if !decided, state == .possible, let start, let touch = touches.first {
            let now = touch.location(in: view)
            let translation = CGSize(width: now.x - start.x, height: now.y - start.y)
            if hypot(translation.width, translation.height) >= 10 {
                decided = true
                let pull = isPullAllowed() && PreviewViewVM.shouldBeginDismissDrag(translation: translation)
                if !pull {
                    // Fail first so the pan's own threshold logic in `super`
                    // cannot move a rejected touch to `.began`; `super` still
                    // runs so UIKit's touch bookkeeping stays consistent.
                    state = .failed
                }
            }
        }
        super.touchesMoved(touches, with: event)
    }
}
#endif
