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
///   • pinch                → the page's `UIScrollView` zoom
///   • horizontal pan       → this pager's page scroll
///   • vertical pull-down   → `pullGate` below, at fit zoom only: it decides
///                            on the first points of travel whether the touch
///                            is a downward pull and FAILS otherwise, and the
///                            page scroll waits on it (`require(toFail:)`) —
///                            so a pull never drags the next page in sideways
///                            and a page swipe never shrinks the photo. The
///                            pull's translation drives `PreviewView`'s still;
///                            its release hands the photo's rect to the host's
///                            hero (`onPlainPullEnded`).
struct PreviewPager: UIViewControllerRepresentable {
    let asset: AssetRef
    let assets: [AssetRef]
    let source: (any ImageSource)?
    let provider: ThumbnailProvider
    let onSelectAsset: (AssetRef) -> Void
    /// The pull's live translation, then its final
    /// translation + velocity on release.
    let onPlainPullChanged: (CGSize) -> Void
    let onPlainPullEnded: (CGSize, CGSize, CGRect?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> UIPageViewController {
        let pager = UIPageViewController(
            transitionStyle: .scroll,
            navigationOrientation: .horizontal
        )
        // Clear: `PreviewView` paints the ground, and fades it during a
        // pull-down so the grid shows through — an opaque page would hide
        // that.
        pager.view.backgroundColor = .clear
        context.coordinator.configure(
            assets: assets,
            source: source,
            provider: provider,
            onSelectAsset: onSelectAsset,
            onPlainPullChanged: onPlainPullChanged,
            onPlainPullEnded: onPlainPullEnded
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
        // horizontal-dominant start fails the gate within its first few
        // points (`PullDownGateRecognizer`), so paging is not perceptibly
        // delayed; a downward start wins the touch.
        for scrollView in pager.view.subviews.compactMap({ $0 as? UIScrollView }) {
            scrollView.panGestureRecognizer.require(toFail: pullGate)
        }
        context.coordinator.pager = pager
        pager.dataSource = context.coordinator
        pager.delegate = context.coordinator
        if let initial = context.coordinator.controller(for: asset.id) {
            pager.setViewControllers([initial], direction: .forward, animated: false)
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
            onPlainPullChanged: onPlainPullChanged,
            onPlainPullEnded: onPlainPullEnded
        )
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
        private var onPlainPullChanged: ((CGSize) -> Void)?
        private var onPlainPullEnded: ((CGSize, CGSize, CGRect?) -> Void)?
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
            onPlainPullChanged: @escaping (CGSize) -> Void,
            onPlainPullEnded: @escaping (CGSize, CGSize, CGRect?) -> Void
        ) {
            self.onSelectAsset = onSelectAsset
            self.onPlainPullChanged = onPlainPullChanged
            self.onPlainPullEnded = onPlainPullEnded
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

        // MARK: Pull-down arbitration

        /// Zoomed in, a vertical pan is the image pan — never a pull.
        var visibleIsAtFitZoom: Bool {
            visiblePage?.isAtFitZoom ?? false
        }

        private var visiblePage: PreviewZoomController? {
            pager?.viewControllers?.first as? PreviewZoomController
        }

        /// The pull's translation drives `PreviewView`'s still; its release
        /// hands the photo's on-screen rect to the host.
        @objc func pullChanged(_ recognizer: UIPanGestureRecognizer) {
            let point = recognizer.translation(in: recognizer.view)
            let translation = CGSize(width: point.x, height: point.y)
            switch recognizer.state {
            case .changed:
                onPlainPullChanged?(translation)
            case .ended, .cancelled, .failed:
                let velocityPoint = recognizer.velocity(in: recognizer.view)
                onPlainPullEnded?(
                    translation, CGSize(width: velocityPoint.x, height: velocityPoint.y),
                    visiblePage?.photoRectInWindow)
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
                // `PhotoGridItem(local:)` uses, so the page paints it on its
                // very first frame instead of a blank.
                seedKey: item.stableID ?? item.id.uuidString,
                source: PreviewViewVM.thumbnailSource(for: item, source: source),
                provider: provider
            )
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

/// A pan that decides, once, after `PreviewViewVM.pullDecisionDistance` of
/// travel whether the touch is a pull-down — and FAILS outright when it is
/// not, so the page scroll that waits on it (`require(toFail:)`) proceeds
/// with no perceptible delay. Deciding in the recognizer's own touch
/// handling (rather than in a `gestureRecognizerShouldBegin` delegate call)
/// is what makes the decision robust: UIKit may ask a delegate to begin a
/// pan after only a point or two of movement, which is not enough to tell a
/// pull from a page swipe.
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
            if hypot(translation.width, translation.height) >= PreviewViewVM.pullDecisionDistance {
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
