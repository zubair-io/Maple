import XCTest
@testable import MapleUI

/// A fake `MuiTransportPlayerControlling` that records every command
/// instead of touching AVFoundation or the network — the same "inject a
/// fake instead of the real thing" split `MuiToastControllerTests` uses
/// for its clock.
private final class FakeTransportPlayer: MuiTransportPlayerControlling {
    private(set) var playCount = 0
    private(set) var pauseCount = 0
    private(set) var seekedTo: [Double] = []

    func play() { playCount += 1 }
    func pause() { pauseCount += 1 }
    func seek(to seconds: Double) { seekedTo.append(seconds) }
}

@MainActor
final class MuiMediaTransportModelTests: XCTestCase {
    func testTogglePlayFromPausedCallsPlay() {
        let player = FakeTransportPlayer()
        let model = MuiMediaTransportModel(player: player, isPlaying: false)

        model.togglePlay()

        XCTAssertEqual(player.playCount, 1)
        XCTAssertEqual(player.pauseCount, 0)
    }

    func testTogglePlayFromPlayingCallsPause() {
        let player = FakeTransportPlayer()
        let model = MuiMediaTransportModel(player: player, isPlaying: true)

        model.togglePlay()

        XCTAssertEqual(player.pauseCount, 1)
        XCTAssertEqual(player.playCount, 0)
    }

    func testSetPlayingUpdatesStateWithoutCommandingThePlayer() {
        let player = FakeTransportPlayer()
        let model = MuiMediaTransportModel(player: player, isPlaying: false)

        model.setPlaying(true)

        XCTAssertTrue(model.isPlaying)
        XCTAssertEqual(player.playCount, 0)
    }

    func testHandleEndedStopsAndRewinds() {
        let player = FakeTransportPlayer()
        let model = MuiMediaTransportModel(player: player, currentTime: 58, duration: 60, isPlaying: true)

        model.handleEnded()

        XCTAssertFalse(model.isPlaying)
        XCTAssertEqual(model.currentTime, 0)
    }

    func testHandleLoadedMetadataPublishesDuration() {
        let player = FakeTransportPlayer()
        let model = MuiMediaTransportModel(player: player)

        model.handleLoadedMetadata(duration: 125)

        XCTAssertEqual(model.duration, 125)
        XCTAssertEqual(model.formattedDuration, "2:05")
    }

    func testHandleLoadedMetadataRejectsNonFiniteDuration() {
        let player = FakeTransportPlayer()
        let model = MuiMediaTransportModel(player: player)

        model.handleLoadedMetadata(duration: .nan)

        XCTAssertEqual(model.duration, 0)
    }

    func testHandleTimeUpdatePublishesCurrentTime() {
        let player = FakeTransportPlayer()
        let model = MuiMediaTransportModel(player: player, duration: 60)

        model.handleTimeUpdate(currentTime: 30)

        XCTAssertEqual(model.currentTime, 30)
        XCTAssertEqual(model.progressPercent, 50)
        XCTAssertEqual(model.formattedCurrentTime, "0:30")
    }

    func testSeekToRatioCommandsThePlayerAndUpdatesCurrentTime() {
        let player = FakeTransportPlayer()
        let model = MuiMediaTransportModel(player: player, duration: 100)

        model.seek(toRatio: 0.25)

        XCTAssertEqual(player.seekedTo, [25])
        XCTAssertEqual(model.currentTime, 25)
    }

    func testSeekToRatioNoOpsWithoutDuration() {
        let player = FakeTransportPlayer()
        let model = MuiMediaTransportModel(player: player, duration: 0)

        model.seek(toRatio: 0.5)

        XCTAssertTrue(player.seekedTo.isEmpty)
        XCTAssertEqual(model.currentTime, 0)
    }
}
