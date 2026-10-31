// PanoDiskFitTests.swift — Storage fit, its place in the merge session's
// output-size choice, and the launch sweep of leftover scratch (#5555).

import XCTest
@testable import MapleCore

final class PanoDiskModelTests: XCTestCase {
    private let model = PanoDiskModel()
    private let sizes = PanoStitchSizes(
        canvasWidth: 20_000, canvasHeight: 10_000, largestFramePixels: 20_000_000, frameCount: 10,
        scratchBytes: 4_000_000_000)
    private var fullPNG: Int { 20_000 * 10_000 * PanoDiskModel.pngBytesPerCanvasPixel }
    private var smallestPNG: Int { sizes.smallestUsefulCanvasPixels * PanoDiskModel.pngBytesPerCanvasPixel }

    private func oneVolume(forPNG png: Int) -> PanoFreeSpace {
        let free = PanoDiskModel.reserveBytes + sizes.scratchBytes + png
        return PanoFreeSpace(scratchVolumeBytes: free, outputVolumeBytes: free, sameVolume: true)
    }

    func testUnknownFreeSpaceMeansNoFit() {
        XCTAssertNil(model.fit(sizes: sizes, space: nil))
    }

    func testFullFitsWithRoomForStoreAndPNG() {
        XCTAssertEqual(model.fit(sizes: sizes, space: oneVolume(forPNG: fullPNG)), .fullFits)
    }

    func testShortStorageGetsASmallerPNGAtTheSameAspect() {
        let fit = model.fit(sizes: sizes, space: oneVolume(forPNG: fullPNG / 4))
        guard case .fitted(let canvas) = fit else {
            return XCTFail("expected a fitted size, got \(String(describing: fit))")
        }
        XCTAssertLessThanOrEqual(canvas.pixels * PanoDiskModel.pngBytesPerCanvasPixel, fullPNG / 4)
        XCTAssertEqual(Double(canvas.width), 10_000, accuracy: 2)
        XCTAssertEqual(Double(canvas.width) / Double(canvas.height), 2, accuracy: 0.01)
    }

    func testAStoreThatDoesNotFitCannotBeHelpedByASmallerOutput() {
        let space = PanoFreeSpace(
            scratchVolumeBytes: sizes.scratchBytes, outputVolumeBytes: sizes.scratchBytes, sameVolume: true)
        XCTAssertEqual(
            model.fit(sizes: sizes, space: space),
            .tooLarge(shortBytes: PanoDiskModel.reserveBytes + smallestPNG),
            "the shortfall is what the smallest useful output needs, not full resolution")
    }

    func testRoomForLessThanAPreviewIsTooLarge() {
        guard case .tooLarge = model.fit(sizes: sizes, space: oneVolume(forPNG: smallestPNG / 2)) else {
            return XCTFail("expected tooLarge")
        }
    }

    func testThePNGIsCheckedOnTheOutputVolume() {
        let roomyScratch = PanoDiskModel.reserveBytes + sizes.scratchBytes
        let fullOutput = PanoFreeSpace(
            scratchVolumeBytes: roomyScratch, outputVolumeBytes: PanoDiskModel.reserveBytes + fullPNG, sameVolume: false)
        XCTAssertEqual(model.fit(sizes: sizes, space: fullOutput), .fullFits, "the store and PNG don't share a volume")

        let shortOutput = PanoFreeSpace(
            scratchVolumeBytes: Int.max / 2, outputVolumeBytes: PanoDiskModel.reserveBytes + fullPNG / 4,
            sameVolume: false)
        guard case .fitted = model.fit(sizes: sizes, space: shortOutput) else {
            return XCTFail("a full output volume must shrink the PNG however roomy the temp volume is")
        }
    }

    func testAShortTempVolumeFailsEvenWithARoomyOutputVolume() {
        let space = PanoFreeSpace(
            scratchVolumeBytes: sizes.scratchBytes, outputVolumeBytes: Int.max / 2, sameVolume: false)
        XCTAssertEqual(model.fit(sizes: sizes, space: space), .tooLarge(shortBytes: PanoDiskModel.reserveBytes))
    }
}

@MainActor
final class PanoDiskFitSessionTests: XCTestCase {
    private let pano01 = PanoStitchSizes(
        canvasWidth: 26_981, canvasHeight: 9_488, largestFramePixels: 20_813_856, frameCount: 21,
        scratchBytes: 4_000_000_000)
    private var assets: [AssetRef] { (0..<3).map { AssetRef.preview(displayName: "IMG_\($0).dng") } }

    private func space(forPNG png: Int) -> PanoFreeSpace {
        let free = PanoDiskModel.reserveBytes + pano01.scratchBytes + png
        return PanoFreeSpace(scratchVolumeBytes: free, outputVolumeBytes: free, sameVolume: true)
    }

    private var halfPNG: Int { pano01.canvasWidth * pano01.canvasHeight * PanoDiskModel.pngBytesPerCanvasPixel / 2 }

    private func session(
        available: Int?, space: PanoFreeSpace?
    ) async -> (PanoMergeSession, RecordingStitcher) {
        let stitcher = RecordingStitcher()
        stitcher.previewSizes = pano01
        let session = PanoMergeSession(
            stitcher: stitcher, previewDebounce: .milliseconds(20),
            availableMemory: { available }, freeSpace: { _, _ in space })
        session.preview(assets: assets)
        let deadline = ContinuousClock.now + .seconds(5)
        while session.lastPreview == nil, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        return (session, stitcher)
    }

    private func stitchCap(_ session: PanoMergeSession, _ stitcher: RecordingStitcher) async -> Int?? {
        session.start(assets: assets)
        let deadline = ContinuousClock.now + .seconds(5)
        while stitcher.stitchCaps.isEmpty, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        return stitcher.stitchCaps.first
    }

    private func memoryBudget(forWidth width: Int) -> Int {
        Int(Double(PanoMemoryModel().estimatedPeakBytes(sizes: pano01, canvasWidth: width)) * PanoMemoryModel.safetyFactor)
    }

    func testShortStorageWithoutAMemoryLimitDefaultsToTheSmallerOutput() async {
        let (session, stitcher) = await session(available: nil, space: space(forPNG: halfPNG))
        XCTAssertNil(session.memoryFit)
        guard case .fitted(let canvas) = session.diskFit else {
            return XCTFail("expected a storage fit, got \(String(describing: session.diskFit))")
        }
        XCTAssertEqual(session.outputSize, .fitted)
        let cap = await stitchCap(session, stitcher)
        XCTAssertEqual(cap, .some(canvas.pixels))
    }

    func testTheTighterOfMemoryAndStorageWins() async {
        let (session, stitcher) = await session(available: memoryBudget(forWidth: 20_000), space: space(forPNG: halfPNG))
        guard case .fitted(_, let memory) = session.memoryFit, case .fitted(let disk) = session.diskFit else {
            return XCTFail("expected both fits to shrink the output")
        }
        XCTAssertEqual(session.fittedOutput?.pixels, min(memory.pixels, disk.pixels))
        let cap = await stitchCap(session, stitcher)
        XCTAssertEqual(cap, .some(min(memory.pixels, disk.pixels)))
    }

    func testRoomyStorageOffersNoChoice() async {
        let roomy = PanoFreeSpace(scratchVolumeBytes: Int.max / 2, outputVolumeBytes: Int.max / 2, sameVolume: true)
        let (session, stitcher) = await session(available: nil, space: roomy)
        XCTAssertEqual(session.diskFit, .fullFits)
        XCTAssertNil(session.fittedOutput)
        let cap = await stitchCap(session, stitcher)
        XCTAssertEqual(cap, .some(nil))
    }

    func testNoSmallerOutputWhenEitherFitSaysNothingHelps() async {
        let storeDoesNotFit = PanoFreeSpace(
            scratchVolumeBytes: pano01.scratchBytes, outputVolumeBytes: pano01.scratchBytes, sameVolume: true)
        let (shortDisk, _) = await session(available: memoryBudget(forWidth: 20_000), space: storeDoesNotFit)
        guard case .fitted = shortDisk.memoryFit, case .tooLarge = shortDisk.diskFit else {
            return XCTFail("expected memory fitted, storage tooLarge")
        }
        XCTAssertNil(shortDisk.fittedOutput)
        XCTAssertEqual(shortDisk.outputSize, .full)

        let (shortMemory, _) = await session(available: memoryBudget(forWidth: 0) / 2, space: space(forPNG: halfPNG))
        guard case .tooLarge = shortMemory.memoryFit, case .fitted = shortMemory.diskFit else {
            return XCTFail("expected memory tooLarge, storage fitted")
        }
        XCTAssertNil(shortMemory.fittedOutput)
        XCTAssertEqual(shortMemory.outputSize, .full)
    }
}

final class PanoScratchSweepTests: XCTestCase {
    func testLaunchSweepRemovesOnlyScratchWhoseProcessHasExited() throws {
        let temp = FileManager.default.temporaryDirectory
        let deadPid = 99_999_999
        let leftover = temp.appendingPathComponent("\(ScratchDirectory.prefix)\(deadPid)-\(UUID().uuidString)")
        let ownCall = temp.appendingPathComponent("\(ScratchDirectory.prefix)\(getpid())-\(UUID().uuidString)")
        let liveStore = temp.appendingPathComponent("maple-pano-frames-\(getpid())-sweep-test")
        let unrelated = temp.appendingPathComponent("maple-pano-\(UUID().uuidString)")
        let kept = [ownCall, liveStore, unrelated]
        for dir in [leftover] + kept {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        defer { kept.forEach { try? FileManager.default.removeItem(at: $0) } }

        RustPanoStitcher.sweepLeftoverScratch()

        XCTAssertFalse(FileManager.default.fileExists(atPath: leftover.path))
        for dir in kept {
            XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path), dir.lastPathComponent)
        }
    }
}
