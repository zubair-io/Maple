#if os(iOS)
import SwiftUI
import MapleCore
import UIKit

// MARK: - UIKit preview pager

/// A page controller that does not expose UIKit's 50%-crossing selection as a
/// SwiftUI binding. `TabView(selection:)` rewrites that binding every time a
/// scrub crosses the midpoint, causing SwiftUI to reconcile the whole Preview
/// repeatedly. This wrapper publishes only after UIKit reports a completed
/// transition, so midpoint scrubbing remains entirely inside UIKit.
struct PreviewPager: UIViewControllerRepresentable {
    let asset: AssetRef
    let assets: [AssetRef]
    let source: (any ImageSource)?
    let provider: ThumbnailProvider
    let onSelectAsset: (AssetRef) -> Void
    let onDismissDragChanged: (CGSize) -> Void
    let onDismissDragEnded: (CGSize, CGSize) -> Void

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
            onDismissDragChanged: onDismissDragChanged,
            onDismissDragEnded: onDismissDragEnded
        )
        let dismissPan = UIPanGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDismissPan(_:))
        )
        dismissPan.maximumNumberOfTouches = 1
        dismissPan.cancelsTouchesInView = false
        dismissPan.delegate = context.coordinator
        pager.view.addGestureRecognizer(dismissPan)
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
            onDismissDragChanged: onDismissDragChanged,
            onDismissDragEnded: onDismissDragEnded
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
        private var onDismissDragChanged: ((CGSize) -> Void)?
        private var onDismissDragEnded: ((CGSize, CGSize) -> Void)?
        weak var pager: UIPageViewController?

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
            onDismissDragChanged: @escaping (CGSize) -> Void,
            onDismissDragEnded: @escaping (CGSize, CGSize) -> Void
        ) {
            self.onSelectAsset = onSelectAsset
            self.onDismissDragChanged = onDismissDragChanged
            self.onDismissDragEnded = onDismissDragEnded
            self.source = source
            self.provider = provider
            let fingerprint = AssetFingerprint(assets)
            guard fingerprint != assetFingerprint else { return }
            assetFingerprint = fingerprint
            self.assets = assets
            assetIndexByID = Dictionary(
                uniqueKeysWithValues: assets.enumerated().map { ($1.id, $0) }
            )
            controllers.removeAll(keepingCapacity: true)
            controllerIndices.removeAll(keepingCapacity: true)
        }

        @objc func handleDismissPan(_ recognizer: UIPanGestureRecognizer) {
            guard let visible = pager?.viewControllers?.first as? PreviewZoomController,
                  visible.isAtFitZoom else {
                if recognizer.state == .ended || recognizer.state == .cancelled {
                    onDismissDragEnded?(.zero, .zero)
                }
                return
            }
            let point = recognizer.translation(in: recognizer.view)
            let translation = CGSize(width: point.x, height: point.y)
            switch recognizer.state {
            case .changed:
                onDismissDragChanged?(translation)
            case .ended, .cancelled, .failed:
                let velocityPoint = recognizer.velocity(in: recognizer.view)
                let velocity = CGSize(width: velocityPoint.x, height: velocityPoint.y)
                onDismissDragEnded?(translation, velocity)
            default:
                break
            }
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool { true }

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
#endif
