// UITestFixtureRootTests.swift — the pure half of fixture-root resolution
// (`Helpers/UITestFixtureRoot.swift`, #2366): which root wins, and whether a
// missing fixture skips or fails. No app launch, so this runs on every
// destination the bundle builds for.

import Foundation
import XCTest

final class UITestFixtureRootTests: XCTestCase {
  private let repoDefault = "/Users/dev/Maple/test-fixtures/raws"

  func testRepoDefaultWalksUpFromTheHelpersDirectory() {
    let path = UITestFixtureRoot.repoDefault(
      sourceFilePath: "/Users/dev/Maple/src/apple/MapleUITests/Helpers/UITestFixtureRoot.swift")
    XCTAssertEqual(path, repoDefault)
  }

  func testNoEnvironmentFallsBackToTheRepoDefault() {
    let resolution = UITestFixtureRoot.resolve(environment: [:], repoDefault: repoDefault)
    XCTAssertEqual(resolution, .init(path: repoDefault, isExplicit: false))
  }

  func testEmptyValueFallsBackToTheRepoDefault() {
    let resolution = UITestFixtureRoot.resolve(
      environment: ["MAPLE_UITEST_FIXTURE_ROOT": ""], repoDefault: repoDefault)
    XCTAssertFalse(resolution.isExplicit)
  }

  /// The iOS Simulator xctestrun leaves the scheme's `$(PROJECT_DIR)`
  /// unexpanded — that is not a root, it's the default.
  func testUnexpandedBuildSettingFallsBackToTheRepoDefault() {
    let resolution = UITestFixtureRoot.resolve(
      environment: ["MAPLE_UITEST_FIXTURE_ROOT": "$(PROJECT_DIR)/../../test-fixtures/raws"],
      repoDefault: repoDefault)
    XCTAssertEqual(resolution, .init(path: repoDefault, isExplicit: false))
  }

  /// The scheme's expanded macOS value is `<src/apple>/../../test-fixtures/raws`
  /// — the repo default spelled with `..` segments, so still not explicit.
  func testTheSchemesOwnValueIsNotExplicit() {
    let resolution = UITestFixtureRoot.resolve(
      environment: [
        "MAPLE_UITEST_FIXTURE_ROOT": "/Users/dev/Maple/src/apple/../../test-fixtures/raws/"
      ],
      repoDefault: repoDefault)
    XCTAssertEqual(resolution, .init(path: repoDefault, isExplicit: false))
  }

  func testAnotherRootIsExplicit() {
    let resolution = UITestFixtureRoot.resolve(
      environment: ["MAPLE_UITEST_FIXTURE_ROOT": "/Volumes/Fixtures/raws"], repoDefault: repoDefault)
    XCTAssertEqual(resolution, .init(path: "/Volumes/Fixtures/raws", isExplicit: true))
  }

  func testMissingAtTheDefaultSkips() {
    let verdict = UITestFixtureRoot.verdict(
      missing: repoDefault + "/test_0017.dng",
      resolution: .init(path: repoDefault, isExplicit: false))
    guard case .skip(let reason) = verdict else { return XCTFail("expected skip, got \(verdict)") }
    XCTAssertTrue(reason.contains("test_0017.dng"))
    XCTAssertTrue(reason.contains("TEST_RUNNER_MAPLE_UITEST_FIXTURE_ROOT"))
  }

  func testMissingAtAnExplicitRootFails() {
    let verdict = UITestFixtureRoot.verdict(
      missing: "/Volumes/Fixtures/raws/test_0017.dng",
      resolution: .init(path: "/Volumes/Fixtures/raws", isExplicit: true))
    guard case .fail(let reason) = verdict else { return XCTFail("expected fail, got \(verdict)") }
    XCTAssertTrue(reason.contains("/Volumes/Fixtures/raws"))
    XCTAssertTrue(reason.contains("test_0017.dng"))
  }
}
