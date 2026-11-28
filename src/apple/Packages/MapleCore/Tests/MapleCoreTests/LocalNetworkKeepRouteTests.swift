import XCTest

@testable import MapleCloudKit

private actor ConfirmLog {
  private(set) var routes: [URL] = []
  private var answers: [URL: Bool] = [:]
  private var hanging: Set<URL> = []
  private var abandoned = 0

  func confirm(_ route: URL) async -> Bool {
    routes.append(route)
    if hanging.contains(route) {
      while !Task.isCancelled { await Task.yield() }
      abandoned += 1
      return false
    }
    return answers[route] ?? false
  }

  func set(_ route: URL, answering answer: Bool) { answers[route] = answer }

  func setHanging(_ route: URL, _ isHanging: Bool) {
    if isHanging { hanging.insert(route) } else { hanging.remove(route) }
  }

  func waitForConfirmations(_ count: Int) async -> Bool {
    await pollUntil { self.routes.count >= count }
  }

  func waitForHangingConfirmationToEnd() async -> Bool {
    await pollUntil { self.abandoned > 0 }
  }
}

@MainActor
final class LocalNetworkKeepRouteTests: XCTestCase {
  private let identity = URL(string: "http://public.example.com")!
  private let lan = URL(string: "https://local.example.com:3443")!
  private let otherLan = URL(string: "http://10.0.0.5:3000")!
  private let debounce = Duration.seconds(1)

  private struct Rig {
    let resolver: LocalNetworkResolver
    let status: StatusGate
    let confirms: ConfirmLog
    let sleeps: SleepGate
    let paths: AsyncStream<Void>.Continuation
  }

  private func makeRig() -> Rig {
    let status = StatusGate()
    let confirms = ConfirmLog()
    let sleeps = SleepGate()
    let (paths, pathFeed) = AsyncStream<Void>.makeStream()
    let identity = identity
    let resolver = LocalNetworkResolver(
      statusProvider: { identity, _ in await status.provide(for: identity) },
      routeConfirmer: { route, _ in await confirms.confirm(route) },
      pathChanges: { paths }, registeredServers: { [identity] },
      pathDebounce: debounce, probeBound: .seconds(5),
      sleeper: { try await sleeps.sleep($0) })
    return Rig(
      resolver: resolver, status: status, confirms: confirms, sleeps: sleeps, paths: pathFeed)
  }

  private func connect(_ rig: Rig, to route: URL) async {
    let launch = Task { await rig.resolver.resolve(identity: identity) }
    let started = await rig.status.waitForCalls(1)
    XCTAssertTrue(started)
    await rig.status.release(call: 1, with: route)
    await launch.value
    await rig.confirms.set(route, answering: true)
  }

  private func waitForTheProbeToFinish(_ rig: Rig) async {
    let finished = LockedValue(false)
    let waiting = Task {
      _ = await rig.resolver.settledEffectiveURL(for: identity, waitingAtMost: .seconds(30))
      finished.value = true
    }
    let done = await pollUntil { finished.value }
    XCTAssertTrue(done)
    if !done {
      await rig.status.releaseEverything(with: lan)
      await rig.sleeps.release(.seconds(30))
    }
    await waiting.value
  }

  private func recheck(_ rig: Rig) async {
    await rig.resolver.resolve(identity: identity)
  }

  func test_aRecheckWhoseCurrentRouteAnswersChangesNothingAndRunsNoResolution() async {
    let rig = makeRig()
    await connect(rig, to: lan)
    let statusBefore = rig.resolver.status(for: identity)

    await recheck(rig)

    let confirmed = await rig.confirms.routes
    let resolutions = await rig.status.calls
    XCTAssertEqual(confirmed, [lan])
    XCTAssertEqual(resolutions, 1)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)
    XCTAssertEqual(rig.resolver.status(for: identity), statusBefore)
  }

  func test_aNetworkChangeRecheckKeepsTheRouteThatStillAnswers() async {
    let rig = makeRig()
    await connect(rig, to: lan)

    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    await rig.sleeps.release(debounce)
    let confirmed = await rig.confirms.waitForConfirmations(1)
    XCTAssertTrue(confirmed)
    await waitForTheProbeToFinish(rig)

    let routes = await rig.confirms.routes
    let resolutions = await rig.status.calls
    XCTAssertEqual(routes, [lan])
    XCTAssertEqual(resolutions, 1)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)
    XCTAssertEqual(
      rig.resolver.status(for: identity),
      LocalNetworkStatus(localURL: lan, isConnectedLocally: true))
  }

  func test_aRecheckWhoseCurrentRouteFailsResolvesAndAdoptsAnotherLANRoute() async {
    let rig = makeRig()
    await connect(rig, to: lan)
    await rig.confirms.set(lan, answering: false)

    let recheck = Task { await rig.resolver.resolve(identity: identity) }
    let resolving = await rig.status.waitForCalls(2)
    XCTAssertTrue(resolving)
    await rig.status.release(call: 2, with: otherLan)
    await recheck.value

    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), otherLan)
    XCTAssertEqual(
      rig.resolver.status(for: identity),
      LocalNetworkStatus(localURL: otherLan, isConnectedLocally: true))
  }

  func test_aRecheckWhoseCurrentRouteFailsFallsBackToTheIdentityWhenNothingAnswers() async {
    let rig = makeRig()
    await connect(rig, to: lan)
    await rig.confirms.set(lan, answering: false)

    let recheck = Task { await rig.resolver.resolve(identity: identity) }
    let resolving = await rig.status.waitForCalls(2)
    XCTAssertTrue(resolving)
    await rig.status.release(call: 2, with: identity)
    await recheck.value

    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), identity)
    XCTAssertEqual(
      rig.resolver.status(for: identity),
      LocalNetworkStatus(localURL: identity, isConnectedLocally: false))
  }

  func test_noStatusIsPublishedWhileARecheckOfAWorkingRouteIsInFlight() async {
    let rig = makeRig()
    await connect(rig, to: lan)
    await rig.confirms.set(lan, answering: false)
    let connected = LocalNetworkStatus(localURL: lan, isConnectedLocally: true)

    let recheck = Task { await rig.resolver.resolve(identity: identity) }
    let resolving = await rig.status.waitForCalls(2)
    XCTAssertTrue(resolving)
    XCTAssertEqual(rig.resolver.status(for: identity), connected)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)

    await rig.status.release(call: 2, with: lan)
    await recheck.value
    XCTAssertEqual(rig.resolver.status(for: identity), connected)
  }

  func test_aRecheckThatTimesOutWhileProbingKeepsTheCachedRouteAndStatus() async {
    let rig = makeRig()
    await connect(rig, to: lan)
    await rig.confirms.set(lan, answering: false)

    let recheck = Task { await rig.resolver.resolve(identity: identity) }
    let resolving = await rig.status.waitForCalls(2)
    XCTAssertTrue(resolving)
    let bounded = await rig.sleeps.waitForStarted(1, of: .seconds(10))
    XCTAssertTrue(bounded)
    await rig.sleeps.release(.seconds(10))
    await recheck.value

    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)
    XCTAssertEqual(
      rig.resolver.status(for: identity),
      LocalNetworkStatus(localURL: lan, isConnectedLocally: true))
    await rig.status.releaseEverything(with: lan)
  }

  func test_aRecheckWithoutALANRouteResolvesInFullAndSwitchesWhenOneIsFound() async {
    let rig = makeRig()
    await connect(rig, to: identity)

    let recheck = Task { await rig.resolver.resolve(identity: identity) }
    let resolving = await rig.status.waitForCalls(2)
    XCTAssertTrue(resolving)
    await rig.status.release(call: 2, with: lan)
    await recheck.value

    let confirmed = await rig.confirms.routes
    XCTAssertEqual(confirmed, [])
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)
    XCTAssertEqual(
      rig.resolver.status(for: identity),
      LocalNetworkStatus(localURL: lan, isConnectedLocally: true))
  }

  func test_aConfirmationCancelledByANetworkChangeNeverCountsAsADeadRoute() async {
    let rig = makeRig()
    await connect(rig, to: lan)
    await rig.confirms.setHanging(lan, true)

    let recheck = Task { await rig.resolver.resolve(identity: identity) }
    let confirming = await rig.confirms.waitForConfirmations(1)
    XCTAssertTrue(confirming)
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    let abandoned = await rig.confirms.waitForHangingConfirmationToEnd()
    XCTAssertTrue(abandoned)
    let resolutionsAfterCancel = await rig.status.calls
    XCTAssertEqual(resolutionsAfterCancel, 1, "a cancelled confirmation does not run a resolution")

    await rig.confirms.setHanging(lan, false)
    await rig.confirms.set(lan, answering: true)
    await rig.sleeps.release(debounce)
    await recheck.value

    let resolutions = await rig.status.calls
    XCTAssertEqual(resolutions, 1)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)
    XCTAssertEqual(
      rig.resolver.status(for: identity),
      LocalNetworkStatus(localURL: lan, isConnectedLocally: true))
  }
}
