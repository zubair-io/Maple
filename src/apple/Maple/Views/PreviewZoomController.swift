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
    /// See `PreviewView.transitionProgress`. Below 1 the still is drawn
    /// between its tile crop (0: aspect-FILL of the page, exactly what the
    /// square grid tile shows) and its final aspect-FIT (1), so the system
    /// zoom — which lays this page out at every size on the way — uncrops
    /// the photo continuously instead of snapping from tile to letterbox.
    private var transitionProgress: CGFloat = 1
    /// A display-tier request that arrived mid-zoom; served once the zoom
    /// settles so the sharper image never pops in halfway through it.
    private var refinementDeferredByTransition = false
    /// The grid tile's already-decoded bitmap, if the cell cached one.
    private let seedImage: UIImage?
    /// The crop scale `applyTransitionCrop` last put on the image view (1 =
    /// none), so it is only ever undone when it is still ours.
    private var transitionCropScale: CGFloat = 1

    var isAtFitZoom: Bool {
        abs(scrollView.zoomScale - scrollView.minimumZoomScale) < 0.01
    }

    /// Where the photo's pixels are on screen right now, in window space —
    /// the rect the Preview hero shrinks from on a pull-down commit. The
    /// image view spans the page with the photo aspect-fit inside it, so
    /// the fit rect is derived from the image size and mapped through
    /// whatever scale/offset the view currently carries.
    var photoRectInWindow: CGRect? {
        guard let image = imageView.image, let window = view.window else { return nil }
        let fit = PreviewViewVM.fitRect(imageSize: image.size, in: imageView.bounds)
        return imageView.convert(fit, to: window)
    }

    init(assetID: AssetRef.ID, seedKey: String, source: ThumbnailSource, provider: ThumbnailProvider) {
        self.assetID = assetID
        self.source = source
        self.provider = provider
        self.seedImage = ThumbnailDecoder.cachedImage(forKey: seedKey).map { UIImage(cgImage: $0) }
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear  // the SwiftUI host paints (and fades) the ground

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
        imageView.image = seedImage
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
            // Bounds + centre, not `frame`: the zoom's crop transform (and
            // the scroll view's own zoom) may be on the view, and `frame`
            // is undefined under a non-identity transform.
            imageView.bounds = CGRect(origin: .zero, size: scrollView.bounds.size)
            imageView.center = CGPoint(x: scrollView.bounds.width / 2, y: scrollView.bounds.height / 2)
            scrollView.contentSize = scrollView.bounds.size
            scrollView.minimumZoomScale = 1
            scrollView.maximumZoomScale = 6
            scrollView.zoomScale = max(1, scrollView.zoomScale)
            centerImage()
            applyTransitionCrop()
        }
    }

    func setTransitionProgress(_ progress: CGFloat) {
        let clamped = min(1, max(0, progress))
        guard clamped != transitionProgress else { return }
        transitionProgress = clamped
        applyTransitionCrop()
        if clamped >= 1, refinementDeferredByTransition {
            refinementDeferredByTransition = false
            requestRefinement(maxDimension: screenPreviewDimension)
        }
    }

    /// Scale the fit still up toward its fill size as the zoom approaches
    /// the tile. The image view is the page's full bounds with an aspect-fit
    /// image centred in it, so scaling the whole view about its centre by
    /// `fill / fit` fills the page with the same centre crop the tile shows;
    /// the scroll view clips the overflow. Only touched while a zoom is
    /// running — at rest the transform belongs to `UIScrollView`'s own
    /// zooming, which sets it directly.
    private func applyTransitionCrop() {
        guard transitionProgress < 1 else {
            // Undo our crop, and only ours — a pinch that began mid-zoom
            // owns the transform now.
            if transitionCropScale != 1, imageView.transform.a == transitionCropScale {
                imageView.transform = .identity
            }
            transitionCropScale = 1
            return
        }
        guard let image = imageView.image else { return }
        let bounds = scrollView.bounds.size
        guard bounds.width > 0, bounds.height > 0,
              image.size.width > 0, image.size.height > 0 else { return }
        let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
        let fill = max(bounds.width / image.size.width, bounds.height / image.size.height)
        let scale = 1 + (fill / fit - 1) * (1 - transitionProgress)
        transitionCropScale = scale
        imageView.transform = CGAffineTransform(scaleX: scale, y: scale)
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
            applyTransitionCrop()
            if refinementActive {
                requestRefinement(maxDimension: screenPreviewDimension)
            }
        }
    }

    /// Reveal the spinner only if the first bytes are still outstanding once
    /// the delay elapses.
    private func startSpinnerDelay() {
        // A seeded tile is already on screen; no spinner over it.
        guard seedImage == nil else { return }
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
        guard transitionProgress >= 1 else {
            refinementDeferredByTransition = true
            return
        }
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
