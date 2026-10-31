// PanoOutputSizeTests.swift — Memory fit and the merge session's output-size
// choice (#5454, #5555).

import XCTest
@testable import MapleCore

final class PanoMemoryModelTests: XCTestCase {
    private let model = PanoMemoryModel()
    private let pano01 = PanoStitchSizes(
        canvasWidth: 26_981, canvasHeight: 9_488, largestFramePixels: 20_813_856, frameCount: 21, scratchBytes: 0)

    private func budgetBytes(forPeak peak: Int) -> Int {
        Int((Double(peak) * PanoMemoryModel.safetyFactor).rounded(.up))
    }

    func testNoLimitMeansNoFit() {
        XCTAssertNil(model.fit(sizes: pano01, availableBytes: nil))
        XCTAssertNil(model.fit(sizes: pano01, availableBytes: 0))
    }

    func testFullFitsWithEnoughMemory() {
        let full = model.estimatedPeakBytes(sizes: pano01, canvasWidth: pano01.canvasWidth)
        XCTAssertEqual(model.fit(sizes: pano01, availableBytes: budgetBytes(forPeak: full)), .fullFits(estimatedBytes: full))
    }

    func testShortDeviceGetsTheLargestCanvasThatFitsAtTheSameAspect() throws {
        let full = model.estimatedPeakBytes(sizes: pano01, canvasWidth: pano01.canvasWidth)
        // Above the ~3k px width where the head takes over.
        let targetWidth = 20_000
        let targetPeak = model.estimatedPeakBytes(sizes: pano01, canvasWidth: targetWidth)
        let fit = model.fit(sizes: pano01, availableBytes: budgetBytes(forPeak: targetPeak))

        guard case .fitted(let fullBytes, let canvas) = fit else {
            return XCTFail("expected a fitted size, got \(String(describing: fit))")
        }
        let (width, height) = (canvas.width, canvas.height)
        XCTAssertEqual(fullBytes, full)
        XCTAssertEqual(Double(width), Double(targetWidth), accuracy: 2)
        XCTAssertEqual(Double(width) / Double(height), 26_981 / 9_488, accuracy: 0.01)
        XCTAssertLessThanOrEqual(
            model.estimatedPeakBytes(sizes: pano01, canvasWidth: width),
            Int(Double(budgetBytes(forPeak: targetPeak)) / PanoMemoryModel.safetyFactor)
        )
    }

    func testTallCanvasKeepsItsAspectAndUsesTheLongEdgeFloor() {
        let tall = PanoStitchSizes(canvasWidth: 9_000, canvasHeight: 40_000, largestFramePixels: 1_000_000, frameCount: 3, scratchBytes: 0)
        let peak = model.estimatedPeakBytes(sizes: tall, canvasWidth: 6_000)
        guard case .fitted(_, let canvas) = model.fit(sizes: tall, availableBytes: budgetBytes(forPeak: peak)) else {
            return XCTFail("expected a fitted size for a tall canvas")
        }
        let (width, height) = (canvas.width, canvas.height)
        XCTAssertLessThan(width, 9_000)
        XCTAssertGreaterThan(height, width)
        XCTAssertEqual(Double(height) / Double(width), 40_000 / 9_000, accuracy: 0.01)
    }

    func testCalibrationCoversTheMeasuredStages() {
        let gib = Double(1 << 30)
        let pano00 = PanoStitchSizes(
            canvasWidth: 12_315, canvasHeight: 12_760, largestFramePixels: 11_648 * 8_640, frameCount: 3, scratchBytes: 0)
        XCTAssertGreaterThanOrEqual(model.headBytes(pano00), 1_263 << 20)
        XCTAssertGreaterThanOrEqual(model.compositeBytes(pano00, canvasWidth: 12_315), 593 << 20)
        XCTAssertGreaterThanOrEqual(model.compositeBytes(pano00, canvasWidth: 12_315), Int(1.2 * gib))
        XCTAssertGreaterThanOrEqual(model.headBytes(pano01), Int(1.8 * gib))
        XCTAssertGreaterThanOrEqual(model.compositeBytes(pano01, canvasWidth: 26_981), Int(2.8 * gib))
    }

    func testFramesAloneTooLargeForTheDevice() {
        let floorOnly = model.estimatedPeakBytes(sizes: pano01, canvasWidth: 0)
        XCTAssertEqual(
            model.fit(sizes: pano01, availableBytes: floorOnly),
            .tooLarge(estimatedFullBytes: model.estimatedPeakBytes(sizes: pano01, canvasWidth: pano01.canvasWidth))
        )
    }

    func testShrinkingBelowTheHeadBuysNothing() {
        let head = model.estimatedPeakBytes(sizes: pano01, canvasWidth: 0)
        XCTAssertEqual(model.estimatedPeakBytes(sizes: pano01, canvasWidth: 2_000), head)
    }

    func testFittedCanvasSmallerThanThePreviewIsTooLarge() {
        let smallFrames = PanoStitchSizes(canvasWidth: 60_000, canvasHeight: 20_000, largestFramePixels: 1_000_000, frameCount: 3, scratchBytes: 0)
        let previewWidthPeak = model.estimatedPeakBytes(sizes: smallFrames, canvasWidth: PanoStitchSizes.smallestUsefulLongEdge - 1)
        let fit = model.fit(sizes: smallFrames, availableBytes: budgetBytes(forPeak: previewWidthPeak))
        guard case .tooLarge = fit else {
            return XCTFail("expected tooLarge, got \(String(describing: fit))")
        }
    }
}

@MainActor
final class PanoOutputSizeSessionTests: XCTestCase {
    private let pano01 = PanoStitchSizes(
        canvasWidth: 26_981, canvasHeight: 9_488, largestFramePixels: 20_813_856, frameCount: 21, scratchBytes: 0)

    private func makeSession(available: Int?, sizes: PanoStitchSizes?) async -> (PanoMergeSession, RecordingStitcher) {
        await makeSession(availableMemory: { available }, sizes: sizes)
    }

    private func makeSession(
        availableMemory: @escaping @Sendable () -> Int?,
        sizes: PanoStitchSizes?
    ) async -> (PanoMergeSession, RecordingStitcher) {
        let stitcher = RecordingStitcher()
        stitcher.previewSizes = sizes
        let session = PanoMergeSession(
            stitcher: stitcher, previewDebounce: .milliseconds(20), availableMemory: availableMemory,
            freeSpace: { _, _ in nil })
        session.preview(assets: (0..<3).map { AssetRef.preview(displayName: "IMG_\($0).dng") })
        let deadline = ContinuousClock.now + .seconds(5)
        while session.lastPreview == nil, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNotNil(session.lastPreview)
        return (session, stitcher)
    }

    private func shortBudget() -> Int {
        let model = PanoMemoryModel()
        let peak = model.estimatedPeakBytes(sizes: pano01, canvasWidth: 20_000)
        return Int(Double(peak) * PanoMemoryModel.safetyFactor)
    }

    private func stitchCap(_ session: PanoMergeSession, _ stitcher: RecordingStitcher) async -> Int?? {
        session.start(assets: (0..<3).map { AssetRef.preview(displayName: "IMG_\($0).dng") })
        let deadline = ContinuousClock.now + .seconds(5)
        while stitcher.stitchCaps.isEmpty, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        return stitcher.stitchCaps.first
    }

    func testNoMemoryLimitStitchesAtTheDefaultCap() async {
        let (session, stitcher) = await makeSession(available: nil, sizes: pano01)
        XCTAssertNil(session.memoryFit)
        XCTAssertEqual(session.outputSize, .full)
        let cap = await stitchCap(session, stitcher)
        XCTAssertEqual(cap, .some(nil))
    }

    func testShortDeviceDefaultsToTheFittedCanvas() async {
        let (session, stitcher) = await makeSession(available: shortBudget(), sizes: pano01)
        guard case .fitted(_, let canvas) = session.memoryFit else {
            return XCTFail("expected a fitted size, got \(String(describing: session.memoryFit))")
        }
        XCTAssertEqual(session.outputSize, .fitted)
        let cap = await stitchCap(session, stitcher)
        XCTAssertEqual(cap, .some(canvas.pixels))
    }

    func testChoosingFullOverridesTheFit() async {
        let (session, stitcher) = await makeSession(available: shortBudget(), sizes: pano01)
        session.outputSize = .full
        let cap = await stitchCap(session, stitcher)
        XCTAssertEqual(cap, .some(nil))
    }

    func testChoiceDoesNotRePreview() async {
        let (session, stitcher) = await makeSession(available: shortBudget(), sizes: pano01)
        session.outputSize = .full
        XCTAssertFalse(session.isPreviewing, "a choice change must not schedule a preview")
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(stitcher.previewCalls.count, 1)
    }

    func testAChosenSmallerSizeFallsBackToFullWhenNoLongerOffered() async {
        let available = AvailableMemory(shortBudget())
        let stitcher = RecordingStitcher()
        stitcher.previewSizes = pano01
        let session = PanoMergeSession(
            stitcher: stitcher, previewDebounce: .milliseconds(20), availableMemory: { available.value },
            freeSpace: { _, _ in nil })
        session.preview(assets: (0..<3).map { AssetRef.preview(displayName: "IMG_\($0).dng") })
        await waitForPreviews(1, session, stitcher)
        session.outputSize = .fitted

        available.value = Int.max / 2
        session.options.localAlign = .off
        await waitForPreviews(2, session, stitcher)

        guard case .fullFits = session.memoryFit else {
            return XCTFail("expected fullFits after memory freed, got \(String(describing: session.memoryFit))")
        }
        XCTAssertEqual(session.outputSize, .full)
        XCTAssertNil(session.outputCanvasCap)
    }

    func testTheFitIsReadOnceWhenThePreviewLands() async {
        let available = AvailableMemory(shortBudget())
        let (session, stitcher) = await makeSession(availableMemory: { available.value }, sizes: pano01)
        guard case .fitted(_, let canvas) = session.memoryFit else {
            return XCTFail("expected a fitted size")
        }
        available.value = Int.max / 2
        let cap = await stitchCap(session, stitcher)
        XCTAssertEqual(cap, .some(canvas.pixels), "the stitch uses the size the sheet showed")
    }

    private func waitForPreviews(_ count: Int, _ session: PanoMergeSession, _ stitcher: RecordingStitcher) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while stitcher.previewCalls.count < count || session.isPreviewing, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(stitcher.previewCalls.count, count)
    }

    func testNewFramesForgetTheChoice() async {
        let (session, _) = await makeSession(available: shortBudget(), sizes: pano01)
        session.outputSize = .full
        session.preview(assets: (0..<4).map { AssetRef.preview(displayName: "OTHER_\($0).dng") })
        let deadline = ContinuousClock.now + .seconds(5)
        while session.lastPreview == nil || session.isPreviewing, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(session.outputSize, .fitted)
    }

    func testAStrategyChangeInsideTheDebounceRefreshesTheFitBeforeStitching() async {
        let smallCanvas = PanoStitchSizes(canvasWidth: 5_000, canvasHeight: 2_000, largestFramePixels: 1_000_000, frameCount: 3, scratchBytes: 0)
        let (session, stitcher) = await makeSession(available: shortBudget(), sizes: smallCanvas)
        guard case .fullFits = session.memoryFit else {
            return XCTFail("expected fullFits first, got \(String(describing: session.memoryFit))")
        }
        let newStrategy: PanoOptions.Strategy = session.options.strategy == .tile ? .rotation : .tile
        stitcher.previewSizes = pano01
        session.options.strategy = newStrategy

        let cap = await stitchCap(session, stitcher)

        XCTAssertEqual(stitcher.previewCalls.last?.options.strategy, newStrategy)
        guard case .fitted(_, let canvas) = session.memoryFit else {
            return XCTFail("expected the new geometry's fit, got \(String(describing: session.memoryFit))")
        }
        XCTAssertEqual(cap, .some(canvas.pixels))
    }

    func testARetentionOrLocalAlignChangeInsideTheDebounceRefreshesTheFit() async {
        let smallCanvas = PanoStitchSizes(canvasWidth: 5_000, canvasHeight: 2_000, largestFramePixels: 1_000_000, frameCount: 3, scratchBytes: 0)
        for change in [\PanoOptions.retention, \PanoOptions.localAlign] as [PartialKeyPath<PanoOptions>] {
            let (session, stitcher) = await makeSession(available: shortBudget(), sizes: smallCanvas)
            guard case .fullFits = session.memoryFit else {
                return XCTFail("expected fullFits first, got \(String(describing: session.memoryFit))")
            }
            stitcher.previewSizes = pano01
            var options = session.options
            if change == \PanoOptions.retention {
                options.retention = options.retention == .keep ? .strict : .keep
            } else {
                options.localAlign = options.localAlign == .off ? .mesh : .off
            }
            session.options = options

            let cap = await stitchCap(session, stitcher)

            XCTAssertEqual(stitcher.previewCalls.last?.options, options, "\(change)")
            guard case .fitted(_, let canvas) = session.memoryFit else {
                return XCTFail("\(change): expected the new options' fit, got \(String(describing: session.memoryFit))")
            }
            XCTAssertEqual(cap, .some(canvas.pixels), "\(change)")
        }
    }

    func testAStrategyChangeWithoutAMemoryLimitStitchesWithoutAnExtraPreview() async {
        let (session, stitcher) = await makeSession(available: nil, sizes: pano01)
        session.options.strategy = session.options.strategy == .tile ? .rotation : .tile
        let cap = await stitchCap(session, stitcher)
        XCTAssertEqual(stitcher.previewCalls.count, 1)
        XCTAssertEqual(cap, .some(nil))
    }

    func testPreviewWithoutSizesOffersNoChoice() async {
        let (session, stitcher) = await makeSession(available: shortBudget(), sizes: nil)
        XCTAssertNil(session.memoryFit)
        let cap = await stitchCap(session, stitcher)
        XCTAssertEqual(cap, .some(nil))
    }
}

private final class AvailableMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: Int

    init(_ bytes: Int) { self.bytes = bytes }

    var value: Int {
        get { lock.withLock { bytes } }
        set { lock.withLock { bytes = newValue } }
    }
}
