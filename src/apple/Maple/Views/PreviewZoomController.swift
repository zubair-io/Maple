#if os(iOS)

import ImageIO
import MapleCore
import UIKit

/// One gesture owner for a Preview page. UIScrollView arbitrates pinch and
/// image pan internally, so carousel and dismissal never infer zoom state
/// through delayed SwiftUI callbacks.
@MainActor
final class PreviewZoomController: UIViewController, UIScrollViewDelegate {
    let assetID: AssetRef.ID

    private let source: ThumbnailSource
    private let provider: ThumbnailProvider
    private let scrollView = UIScrollView()
    private let imageView = UIImageView()
    /// Shown while the first bytes are in flight (#2377). Until now this page
    /// rendered a bare backdrop until an image landed, which for a
    /// network-bound cloud fetch is an indefinite blank screen.
    private let spinner = UIActivityIndicatorView(style: .large)
    /// Terminal state — the source had nothing for us. Kept distinct from the
    /// spinner so "loading" and "failed" never read as each other.
    private let failureView = UIImageView(
        image: UIImage(systemName: "photo")?.withConfiguration(
            UIImage.SymbolConfiguration(pointSize: 56)
        )
    )
    private var spinnerDelayTask: Task<Void, Never>?
    /// The common case is a cached thumbnail resolving in a frame or two;
    /// gating the spinner behind this keeps it from flashing there.
    private static let spinnerDelayNanoseconds: UInt64 = 250_000_000
    private var thumbnailTask: Task<Void, Never>?
    private var refinementTask: Task<Void, Never>?
    private var refinementActive = false
    private var loadedMaxDimension: CGFloat = 256
    private var requestedMaxDimension: CGFloat = 0
    private var refinementGeneration: UInt64 = 0

    var isAtFitZoom: Bool {
        abs(scrollView.zoomScale - scrollView.minimumZoomScale) < 0.01
    }

    init(assetID: AssetRef.ID, source: ThumbnailSource, provider: ThumbnailProvider) {
        self.assetID = assetID
        self.source = source
        self.provider = provider
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(MapleTokens.bg)

        scrollView.delegate = self
        scrollView.bouncesZoom = true
        scrollView.decelerationRate = .fast
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.panGestureRecognizer.isEnabled = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)

        imageView.contentMode = .scaleAspectFit
        imageView.clipsToBounds = true
        scrollView.addSubview(imageView)

        // Both status views sit on the controller's view, not inside the
        // scroll view: they must stay centred on screen and must not be
        // zoomed or panned along with the photo.
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        spinner.accessibilityIdentifier = "preview-image-loading"
        view.addSubview(spinner)

        failureView.translatesAutoresizingMaskIntoConstraints = false
        failureView.tintColor = UIColor(ProTokens.textDim)
        failureView.isHidden = true
        failureView.accessibilityIdentifier = "preview-image-failed"
        view.addSubview(failureView)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failureView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            failureView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        startSpinnerDelay()
        loadThumbnail()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard imageView.image != nil else { return }
        // Zoom changes the transformed frame, but not bounds. Comparing the
        // frame here treated every pinch as a layout-size change and could
        // reset zoom state on the next layout pass.
        if imageView.bounds.size != scrollView.bounds.size {
            imageView.frame = CGRect(origin: .zero, size: scrollView.bounds.size)
            scrollView.contentSize = scrollView.bounds.size
            scrollView.minimumZoomScale = 1
            scrollView.maximumZoomScale = 6
            scrollView.zoomScale = max(1, scrollView.zoomScale)
            centerImage()
        }
    }

    func setRefinementActive(_ active: Bool) {
        refinementActive = active
        if active {
            view.layoutIfNeeded()
            requestRefinement(maxDimension: screenPreviewDimension)
        } else {
            refinementGeneration &+= 1
            refinementTask?.cancel()
            refinementTask = nil
            requestedMaxDimension = loadedMaxDimension
        }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        scrollView.panGestureRecognizer.isEnabled = !isAtFitZoom
        centerImage()
    }

    func scrollViewDidEndZooming(
        _ scrollView: UIScrollView,
        with view: UIView?,
        atScale scale: CGFloat
    ) {
        guard refinementActive else { return }
        requestRefinement(maxDimension: min(8_192, screenPreviewDimension * scale))
    }

    private func centerImage() {
        let horizontal = max(0, (scrollView.bounds.width - scrollView.contentSize.width) / 2)
        let vertical = max(0, (scrollView.bounds.height - scrollView.contentSize.height) / 2)
        scrollView.contentInset = UIEdgeInsets(
            top: vertical, left: horizontal, bottom: vertical, right: horizontal
        )
    }

    private func loadThumbnail() {
        thumbnailTask = Task { [weak self] in
            guard let self else { return }
            let data = await provider.thumbnail(for: source)
            guard !Task.isCancelled else { return }
            guard let data, let image = Self.image(from: data) else {
                // The source's terminal answer, not a slow one — stop the
                // spinner rather than leaving it turning forever.
                showFailure()
                return
            }
            imageView.image = image
            hideStatusViews()
            view.setNeedsLayout()
            if refinementActive {
                requestRefinement(maxDimension: screenPreviewDimension)
            }
        }
    }

    /// Reveal the spinner only if the first bytes are still outstanding once
    /// the delay elapses.
    private func startSpinnerDelay() {
        spinnerDelayTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.spinnerDelayNanoseconds)
            guard let self, !Task.isCancelled, imageView.image == nil,
                  failureView.isHidden else { return }
            spinner.startAnimating()
        }
    }

    private func hideStatusViews() {
        spinnerDelayTask?.cancel()
        spinnerDelayTask = nil
        spinner.stopAnimating()
        failureView.isHidden = true
    }

    private func showFailure() {
        hideStatusViews()
        failureView.isHidden = false
    }

    private var screenPreviewDimension: CGFloat {
        let points = max(scrollView.bounds.width, scrollView.bounds.height, 1)
        return min(4_096, max(2_048, points * view.traitCollection.displayScale))
    }

    private func requestRefinement(maxDimension: CGFloat) {
        let target = max(2_048, maxDimension.rounded(.up))
        guard refinementActive,
              target > loadedMaxDimension * 1.2,
              target > requestedMaxDimension * 1.1 else { return }

        refinementTask?.cancel()
        refinementGeneration &+= 1
        let generation = refinementGeneration
        requestedMaxDimension = target
        refinementTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if refinementGeneration == generation { refinementTask = nil }
            }
            guard let data = await provider.preview(for: source, maxDimension: target),
                  !Task.isCancelled, refinementActive,
                  refinementGeneration == generation,
                  let image = Self.image(from: data) else { return }
            imageView.image = image
            loadedMaxDimension = target
        }
    }

    private nonisolated static func image(from data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        return UIImage(cgImage: image)
    }

    deinit {
        thumbnailTask?.cancel()
        refinementTask?.cancel()
        spinnerDelayTask?.cancel()
    }
}

#endif
