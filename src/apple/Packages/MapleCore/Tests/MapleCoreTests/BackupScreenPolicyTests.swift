// BackupScreenPolicyTests.swift — keep-awake and screen-saver decisions while
// a Photos backup uploads (#5457).

import XCTest

@testable import MapleCore

final class BackupScreenPolicyTests: XCTestCase {
  private let enabled = BackupScreenPreferences(keepScreenOn: true, screenSaverEnabled: true)

  private func state(
    running: Bool = true,
    sinceUpload: TimeInterval? = 0,
    sinceBytes: TimeInterval? = nil,
    power: DevicePower = .pluggedIn,
    idle: TimeInterval = 0,
    assisted: Bool = false,
    editor: Bool = false,
    preferences: BackupScreenPreferences? = nil
  ) -> BackupScreenState {
    BackupScreenState(
      backupRunning: running, secondsSinceUpload: sinceUpload,
      secondsSinceBytesSent: sinceBytes, power: power,
      secondsSinceInteraction: idle, assistedInputActive: assisted,
      editorVisible: editor, preferences: preferences ?? enabled)
  }

  func test_pluggedInUpload_keepsAwake_withoutSaverBeforeDelay() {
    let decision = BackupScreenPolicy.decide(state(idle: BackupScreenPolicy.screenSaverDelay - 1))
    XCTAssertEqual(decision, BackupScreenDecision(keepScreenAwake: true, showScreenSaver: false))
  }

  func test_pluggedInUpload_showsSaverOnceIdleForTheDelay() {
    let decision = BackupScreenPolicy.decide(state(idle: BackupScreenPolicy.screenSaverDelay))
    XCTAssertEqual(decision, BackupScreenDecision(keepScreenAwake: true, showScreenSaver: true))
  }

  func test_pluggedIn_holdsScreenForArbitrarilyLongIdle() {
    let decision = BackupScreenPolicy.decide(state(idle: 6 * 60 * 60))
    XCTAssertTrue(decision.keepScreenAwake)
    XCTAssertTrue(decision.showScreenSaver)
  }

  func test_battery_neverShowsSaver() {
    let decision = BackupScreenPolicy.decide(
      state(power: .battery, idle: BackupScreenPolicy.screenSaverDelay * 2))
    XCTAssertFalse(decision.showScreenSaver)
  }

  func test_battery_releasesScreenAfterTheBatteryLimit() {
    let held = BackupScreenPolicy.decide(
      state(power: .battery, idle: BackupScreenPolicy.batteryAwakeLimit - 1))
    let released = BackupScreenPolicy.decide(
      state(power: .battery, idle: BackupScreenPolicy.batteryAwakeLimit))
    XCTAssertTrue(held.keepScreenAwake)
    XCTAssertEqual(released, .released)
  }

  func test_keepScreenOnDisabled_releasesEverything() {
    let preferences = BackupScreenPreferences(keepScreenOn: false, screenSaverEnabled: true)
    let decision = BackupScreenPolicy.decide(
      state(idle: BackupScreenPolicy.screenSaverDelay, preferences: preferences))
    XCTAssertEqual(decision, .released)
  }

  func test_screenSaverDisabled_stillKeepsAwake() {
    let preferences = BackupScreenPreferences(keepScreenOn: true, screenSaverEnabled: false)
    let decision = BackupScreenPolicy.decide(
      state(idle: BackupScreenPolicy.screenSaverDelay, preferences: preferences))
    XCTAssertEqual(decision, BackupScreenDecision(keepScreenAwake: true, showScreenSaver: false))
  }

  func test_stoppedBackup_releases() {
    XCTAssertEqual(BackupScreenPolicy.decide(state(running: false, idle: 600)), .released)
  }

  func test_runningWithNothingUploaded_releases() {
    XCTAssertEqual(BackupScreenPolicy.decide(state(sinceUpload: nil, idle: 600)), .released)
  }

  func test_shortGapBetweenPhotos_stillCountsAsUploading() {
    let decision = BackupScreenPolicy.decide(
      state(sinceUpload: BackupScreenPolicy.uploadGrace, idle: 600))
    XCTAssertTrue(decision.showScreenSaver)
  }

  func test_stalledUpload_releasesAfterTheGrace() {
    let decision = BackupScreenPolicy.decide(
      state(sinceUpload: BackupScreenPolicy.uploadGrace + 1, idle: 600))
    XCTAssertEqual(decision, .released)
  }

  func test_slowChunkStillSendingBytes_staysUploading() {
    let decision = BackupScreenPolicy.decide(
      state(sinceUpload: 64, sinceBytes: 16, idle: 600))
    XCTAssertEqual(decision, BackupScreenDecision(keepScreenAwake: true, showScreenSaver: true))
  }

  func test_requestJustStarted_beforeAnyPhotoProgress_staysUploading() {
    let decision = BackupScreenPolicy.decide(state(sinceUpload: nil, sinceBytes: 0, idle: 600))
    XCTAssertTrue(decision.keepScreenAwake)
  }

  func test_requestWithoutByteMovementPastTheCutoff_isStalled() {
    let atCutoff = BackupScreenPolicy.decide(
      state(sinceUpload: 90, sinceBytes: BackupScreenPolicy.transferStallCutoff, idle: 600))
    let pastCutoff = BackupScreenPolicy.decide(
      state(sinceUpload: 90, sinceBytes: BackupScreenPolicy.transferStallCutoff + 1, idle: 600))
    XCTAssertTrue(atCutoff.keepScreenAwake)
    XCTAssertEqual(pastCutoff, .released)
  }

  func test_finishedBackup_releasesEvenWithRecentBytes() {
    XCTAssertEqual(
      BackupScreenPolicy.decide(state(running: false, sinceBytes: 0, idle: 600)), .released)
  }

  func test_failedUploadWithNoRequestInFlight_releasesAfterTheGrace() {
    let decision = BackupScreenPolicy.decide(
      state(sinceUpload: BackupScreenPolicy.uploadGrace + 1, sinceBytes: nil, idle: 600))
    XCTAssertEqual(decision, .released)
  }

  func test_assistedInput_suppressesSaverButKeepsAwake() {
    let decision = BackupScreenPolicy.decide(state(idle: 600, assisted: true))
    XCTAssertEqual(decision, BackupScreenDecision(keepScreenAwake: true, showScreenSaver: false))
  }

  func test_editorVisible_suppressesSaverButKeepsAwake() {
    let decision = BackupScreenPolicy.decide(state(idle: 600, editor: true))
    XCTAssertEqual(decision, BackupScreenDecision(keepScreenAwake: true, showScreenSaver: false))
  }

  func test_editorVisibleOnBattery_keepsTheBatteryAwakeLimit() {
    let held = BackupScreenPolicy.decide(
      state(power: .battery, idle: BackupScreenPolicy.batteryAwakeLimit - 1, editor: true))
    let released = BackupScreenPolicy.decide(
      state(power: .battery, idle: BackupScreenPolicy.batteryAwakeLimit, editor: true))
    XCTAssertEqual(held, BackupScreenDecision(keepScreenAwake: true, showScreenSaver: false))
    XCTAssertEqual(released, .released)
  }

  func test_leavingTheEditor_showsSaverOnceIdleForTheDelay() {
    let decision = BackupScreenPolicy.decide(
      state(idle: BackupScreenPolicy.screenSaverDelay, editor: false))
    XCTAssertEqual(decision, BackupScreenDecision(keepScreenAwake: true, showScreenSaver: true))
  }

  func test_unpluggingWhileSaverShows_closesSaverAndHoldsUntilBatteryLimit() {
    let showing = BackupScreenPolicy.decide(state(idle: 300))
    let unplugged = BackupScreenPolicy.decide(state(power: .battery, idle: 300))
    XCTAssertTrue(showing.showScreenSaver)
    XCTAssertEqual(unplugged, BackupScreenDecision(keepScreenAwake: true, showScreenSaver: false))
  }

  func test_preferences_defaultToKeepAwakeWithoutSaverAndPersistPerDevice() throws {
    let suiteName = "BackupScreenPolicyTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let defaultPreferences = BackupScreenPreferences.load(from: defaults)
    XCTAssertEqual(
      defaultPreferences, BackupScreenPreferences(keepScreenOn: true, screenSaverEnabled: false))
    XCTAssertEqual(
      BackupScreenPolicy.decide(state(idle: 600, preferences: defaultPreferences)),
      BackupScreenDecision(keepScreenAwake: true, showScreenSaver: false))

    defaults.set(true, forKey: BackupScreenPreferences.screenSaverKey)
    XCTAssertEqual(
      BackupScreenPreferences.load(from: defaults),
      BackupScreenPreferences(keepScreenOn: true, screenSaverEnabled: true))

    defaults.set(false, forKey: BackupScreenPreferences.keepScreenOnKey)
    XCTAssertEqual(
      BackupScreenPreferences.load(from: defaults),
      BackupScreenPreferences(keepScreenOn: false, screenSaverEnabled: true))
  }
}
