import XCTest

@testable import MapleCloudKit

@MainActor
final class LocalNetworkReprobeTests: XCTestCase {
  private let identity = URL(string: "http://public.example.com")!
  private let lan = URL(string: "http://10.0.0.5:3000")!
  private let debounce = Duration.seconds(1)
  private let settledLimit = Duration.seconds(30)

  private struct Rig {
    let resolver: LocalNetworkResolver
    let status: StatusGate
    let sleeps: SleepGate
    let paths: AsyncStream<Void>.Continuation
    let activity: AsyncStream<Bool>.Continuation
  }

  private func makeRig(
    initiallyActive: Bool = true, notifications: Bool = true,
    registered: LockedValue<[URL]>? = nil
  ) -> Rig {
    let status = StatusGate()
    let sleeps = SleepGate()
    let (paths, pathFeed) = AsyncStream<Void>.makeStream()
    let (activity, activityFeed) = AsyncStream<Bool>.makeStream()
    let identity = identity
    let servers = registered ?? LockedValue<[URL]>([identity])
    let activityStream: @Sendable () -> AsyncStream<Bool> = { activity }
    let activityFactory = notifications ? activityStream : nil
    let resolver = LocalNetworkResolver(
      statusProvider: { identity, _ in await status.provide(for: identity) },
      routeConfirmer: { _, _ in false },
      pathChanges: { paths }, activityChanges: activityFactory,
      initiallyActive: initiallyActive,
      registeredServers: { servers.value },
      pathDebounce: debounce, probeBound: .seconds(5),
      sleeper: { try await sleeps.sleep($0) })
    return Rig(
      resolver: resolver, status: status, sleeps: sleeps, paths: pathFeed, activity: activityFeed)
  }

  private func settle(_ rig: Rig, resolving identity: URL, call: Int, to url: URL) async {
    let first = Task { await rig.resolver.resolve(identity: identity) }
    let reached = await rig.status.waitForCalls(call)
    XCTAssertTrue(reached)
    await rig.status.release(call: call, with: url)
    await first.value
  }

  private func yieldABunch() async {
    for _ in 0..<50 { await Task.yield() }
  }

  func test_pathFilter_ignoresTheFirstAndOfflineUpdatesAndReprobesOnEveryOtherOne() {
    var filter = LocalNetworkPathFilter()
    XCTAssertFalse(filter.shouldReprobe(isSatisfied: true))
    XCTAssertTrue(
      filter.shouldReprobe(isSatisfied: true),
      "an identical-looking update can be another network behind the same gateway address")
    XCTAssertFalse(filter.shouldReprobe(isSatisfied: false))
    XCTAssertTrue(filter.shouldReprobe(isSatisfied: true))
  }

  func test_aServerRemovedWhileItsProbeRunsReleasesItsWaiterAndCanBeAddedBack() async {
    let registered = LockedValue([identity])
    let rig = makeRig(registered: registered)
    await settle(rig, resolving: identity, call: 1, to: identity)
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    let waiter = Task { await rig.resolver.resolve(identity: identity) }
    let probing = await rig.status.waitForCalls(2)
    XCTAssertTrue(probing)
    registered.value = []
    await rig.sleeps.release(debounce)

    let released = LockedValue(false)
    Task {
      await waiter.value
      released.value = true
    }
    let done = await pollUntil { released.value }
    XCTAssertTrue(done)
    XCTAssertNil(rig.resolver.status(for: identity))

    registered.value = [identity]
    let readded = Task { await rig.resolver.resolve(identity: identity) }
    let probedAgain = await rig.status.waitForCalls(3)
    XCTAssertTrue(probedAgain)
    await rig.status.releaseEverything(with: lan)
    let resolvedAgain = await pollUntil { self.hasEffectiveURL(self.lan, in: rig) }
    XCTAssertTrue(resolvedAgain)
    await rig.sleeps.release(.seconds(10))
    await readded.value
  }

  func test_aBurstOfPathChangesCausesOneReprobe() async {
    let rig = makeRig()
    await settle(rig, resolving: identity, call: 1, to: identity)
    rig.paths.yield()
    rig.paths.yield()
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(3, of: debounce)
    XCTAssertTrue(debounced)
    let callsBeforeQuiet = await rig.status.calls
    XCTAssertEqual(callsBeforeQuiet, 1)
    let superseded = await rig.sleeps.waitForCancelled(2, of: debounce)
    XCTAssertTrue(superseded)
    await rig.sleeps.release(debounce)
    let reprobed = await rig.status.waitForCalls(2)
    XCTAssertTrue(reprobed)
    await rig.status.release(call: 2, with: lan)
    let applied = await pollUntil { self.hasEffectiveURL(self.lan, in: rig) }
    XCTAssertTrue(applied)
    let calls = await rig.status.calls
    XCTAssertEqual(calls, 2)
  }

  private func hasEffectiveURL(_ url: URL, in rig: Rig) -> Bool {
    rig.resolver.effectiveURL(for: identity) == url
  }

  func test_aReprobeThatFinishesAfterANewerOneDoesNotOverwriteIt() async {
    let rig = makeRig()
    let first = Task { await rig.resolver.resolve(identity: identity) }
    let started = await rig.status.waitForCalls(1)
    XCTAssertTrue(started)
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    await rig.sleeps.release(debounce)
    let reprobed = await rig.status.waitForCalls(2)
    XCTAssertTrue(reprobed)

    await rig.status.release(call: 2, with: lan)
    await first.value
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)
    await rig.status.release(call: 1, with: identity)
    await yieldABunch()
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)
    XCTAssertEqual(
      rig.resolver.status(for: identity),
      LocalNetworkStatus(localURL: lan, isConnectedLocally: true))
  }

  func test_settledEffectiveURL_waitsForTheProbeThatReplacedTheOneItWasWaitingOn() async {
    let rig = makeRig()
    let launchProbe = Task { await rig.resolver.resolve(identity: identity) }
    let started = await rig.status.waitForCalls(1)
    XCTAssertTrue(started)
    let folderOpen = Task {
      await rig.resolver.settledEffectiveURL(for: identity, waitingAtMost: settledLimit)
    }
    let folderWaiting = await rig.sleeps.waitForStarted(1, of: settledLimit)
    XCTAssertTrue(folderWaiting)
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    await rig.sleeps.release(debounce)
    let reprobed = await rig.status.waitForCalls(2)
    XCTAssertTrue(reprobed)

    let finished = LockedValue(false)
    Task {
      _ = await folderOpen.value
      finished.value = true
    }
    await rig.status.release(call: 1, with: identity)
    await yieldABunch()
    XCTAssertFalse(finished.value, "the folder open keeps waiting for the replacement probe")
    await rig.status.release(call: 2, with: lan)
    let folderDone = await pollUntil { finished.value }
    XCTAssertTrue(folderDone)
    await rig.status.releaseEverything(with: lan)
    let settled = await folderOpen.value
    XCTAssertEqual(settled, lan)
    await launchProbe.value
  }

  func test_aProbeStartedAfterThePathChangeIsNotRestarted() async {
    let rig = makeRig()
    await settle(rig, resolving: identity, call: 1, to: identity)
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    let foreground = Task { await rig.resolver.resolve(identity: identity) }
    let foregroundProbe = await rig.status.waitForCalls(2)
    XCTAssertTrue(foregroundProbe)

    await rig.sleeps.release(debounce)
    let debounceRan = await pollUntil { !rig.resolver.reprobeDue }
    XCTAssertTrue(debounceRan)
    await rig.status.release(call: 2, with: lan)
    let applied = await pollUntil { self.hasEffectiveURL(self.lan, in: rig) }
    XCTAssertTrue(applied, "the foreground probe was not cancelled by the debounced re-probe")
    await rig.status.releaseEverything(with: lan)
    await foreground.value
    let calls = await rig.status.calls
    XCTAssertEqual(calls, 2)
  }

  func test_aWaiterIsReleasedAtTheCapAndTheCachedRouteIsKeptWhenProbesKeepBeingReplaced() async {
    let rig = makeRig()
    await settle(rig, resolving: identity, call: 1, to: lan)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)

    rig.paths.yield()
    let firstDebounce = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(firstDebounce)
    await rig.sleeps.release(debounce)
    let secondProbe = await rig.status.waitForCalls(2)
    XCTAssertTrue(secondProbe)
    let waiter = Task { await rig.resolver.resolve(identity: identity) }
    let bounded = await rig.sleeps.waitForStarted(2, of: .seconds(10))
    XCTAssertTrue(bounded)

    rig.paths.yield()
    let secondDebounce = await rig.sleeps.waitForStarted(2, of: debounce)
    XCTAssertTrue(secondDebounce)
    await rig.sleeps.release(debounce)
    let thirdProbe = await rig.status.waitForCalls(3)
    XCTAssertTrue(thirdProbe)
    await rig.status.release(call: 2, with: lan)

    let released = LockedValue(false)
    Task {
      await waiter.value
      released.value = true
    }
    await rig.sleeps.release(.seconds(10))
    let waiterReleased = await pollUntil { released.value }
    XCTAssertTrue(waiterReleased)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)
    XCTAssertEqual(
      rig.resolver.status(for: identity),
      LocalNetworkStatus(localURL: lan, isConnectedLocally: true))
    await rig.status.releaseEverything(with: identity)
  }

  func test_aServerRemovedFromTheRegistryIsNoLongerReprobed() async {
    let other = URL(string: "http://other.example.com")!
    let registered = LockedValue([identity, other])
    let rig = makeRig(registered: registered)
    await settle(rig, resolving: identity, call: 1, to: lan)
    await settle(rig, resolving: other, call: 2, to: lan)

    registered.value = [other]
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    await rig.sleeps.release(debounce)
    let remaining = await rig.status.waitForCalls(3)
    XCTAssertTrue(remaining)
    let pruned = await pollUntil { rig.resolver.status(for: identity) == nil }
    XCTAssertTrue(pruned)
    let removedCalls = await rig.status.callCount(host: "public.example.com")
    let keptCalls = await rig.status.callCount(host: "other.example.com")
    XCTAssertEqual(removedCalls, 1)
    XCTAssertEqual(keptCalls, 2)
    await rig.status.releaseEverything(with: lan)
  }

  func test_aPathChangeWhileInactiveProbesOnceWhenTheAppBecomesActive() async {
    let rig = makeRig(initiallyActive: false)
    await settle(rig, resolving: identity, call: 1, to: identity)
    rig.paths.yield()
    rig.paths.yield()
    let markedDue = await pollUntil { rig.resolver.reprobeDue }
    XCTAssertTrue(markedDue)
    let debounceStarts = await rig.sleeps.startedCount(debounce)
    let callsWhileInactive = await rig.status.calls
    XCTAssertEqual(debounceStarts, 0)
    XCTAssertEqual(callsWhileInactive, 1)

    rig.activity.yield(true)
    let reprobed = await rig.status.waitForCalls(2)
    XCTAssertTrue(reprobed)
    await rig.status.release(call: 2, with: lan)
    let applied = await pollUntil { self.hasEffectiveURL(self.lan, in: rig) }
    XCTAssertTrue(applied)
    rig.activity.yield(false)
    rig.activity.yield(true)
    await yieldABunch()
    let calls = await rig.status.calls
    XCTAssertEqual(calls, 2, "the due re-probe ran once and is no longer due")
  }

  func test_leavingTheForegroundDuringTheDebounceDefersTheReprobe() async {
    let rig = makeRig()
    await settle(rig, resolving: identity, call: 1, to: identity)
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    rig.activity.yield(false)
    await yieldABunch()
    await rig.sleeps.release(debounce)
    await yieldABunch()
    let callsInBackground = await rig.status.calls
    XCTAssertEqual(callsInBackground, 1)

    rig.activity.yield(true)
    let reprobed = await rig.status.waitForCalls(2)
    XCTAssertTrue(reprobed)
    await rig.status.releaseEverything(with: identity)
  }

  func test_aResolverSeededActiveReprobesOnTheFirstPathChange() async {
    let rig = makeRig(notifications: false)
    await settle(rig, resolving: identity, call: 1, to: identity)
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    await rig.sleeps.release(debounce)
    let reprobed = await rig.status.waitForCalls(2)
    XCTAssertTrue(reprobed)
    await rig.status.releaseEverything(with: lan)
  }

  func test_anExtensionStyleResolverNeverReprobes() async {
    let rig = makeRig(initiallyActive: false, notifications: false)
    await settle(rig, resolving: identity, call: 1, to: identity)
    rig.paths.yield()
    rig.paths.yield()
    let markedDue = await pollUntil { rig.resolver.reprobeDue }
    XCTAssertTrue(markedDue)
    let debounceStarts = await rig.sleeps.startedCount(debounce)
    let calls = await rig.status.calls
    XCTAssertEqual(debounceStarts, 0)
    XCTAssertEqual(calls, 1)
    XCTAssertTrue(rig.resolver.reprobeDue)
  }

  func test_extensionBundlesAreRecognisedByTheirPath() {
    XCTAssertTrue(AppActivity.isExtension(bundlePath: "/x/Maple.app/PlugIns/Widget.appex"))
    XCTAssertFalse(AppActivity.isExtension(bundlePath: "/x/Maple.app"))
  }

  func test_aBurstReplacesTheDebounceInsteadOfStackingThem() async {
    let rig = makeRig()
    await settle(rig, resolving: identity, call: 1, to: identity)
    rig.paths.yield()
    rig.paths.yield()
    rig.paths.yield()
    let replaced = await rig.sleeps.waitForCancelled(2, of: debounce)
    XCTAssertTrue(replaced, "each new path update cancels the pending debounce")
  }

  func test_theDueFlagIsClearedOnceItHasRun() async {
    let rig = makeRig(initiallyActive: false)
    await settle(rig, resolving: identity, call: 1, to: identity)
    rig.paths.yield()
    let due = await pollUntil { rig.resolver.reprobeDue }
    XCTAssertTrue(due)
    rig.activity.yield(true)
    let cleared = await pollUntil { !rig.resolver.reprobeDue }
    XCTAssertTrue(cleared)
    await rig.status.releaseEverything(with: identity)
  }

  func test_aProbeThatBeganBeforeThePathChangeStoresNothingDuringTheDebounce() async {
    let rig = makeRig()
    let waiter = Task { await rig.resolver.resolve(identity: identity) }
    let started = await rig.status.waitForCalls(1)
    XCTAssertTrue(started)
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)

    let released = LockedValue(false)
    Task {
      await waiter.value
      released.value = true
    }
    await rig.status.release(call: 1, with: lan)
    await yieldABunch()
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), identity)
    XCTAssertFalse(released.value, "waiters follow the replacement probe")

    await rig.sleeps.release(debounce)
    let replacement = await rig.status.waitForCalls(2)
    XCTAssertTrue(replacement)
    await rig.status.release(call: 2, with: identity)
    let done = await pollUntil { released.value }
    XCTAssertTrue(done)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), identity)
  }

  func test_aRemovedServerLosesItsCachedAddressAndStatus() async {
    let registered = LockedValue([identity])
    let rig = makeRig(registered: registered)
    await settle(rig, resolving: identity, call: 1, to: lan)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)

    registered.value = []
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    await rig.sleeps.release(debounce)
    let dropped = await pollUntil { rig.resolver.status(for: identity) == nil }
    XCTAssertTrue(dropped)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), identity)
  }

  private func pathChangeKeepsTheCachedRoute(_ rig: Rig) async {
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    await rig.sleeps.release(debounce)
    let reprobed = await rig.status.waitForCalls(2)
    XCTAssertTrue(reprobed)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), lan)
    XCTAssertEqual(
      rig.resolver.status(for: identity),
      LocalNetworkStatus(localURL: lan, isConnectedLocally: true))
    await rig.status.releaseEverything(with: lan)
  }

  func test_aRegistryEntryThatDiffersOnlyInCaseAndTrailingSlashKeepsItsRoute() async {
    let variant = URL(string: "HTTP://Public.Example.com/")!
    let registered = LockedValue([identity])
    let rig = makeRig(registered: registered)
    await settle(rig, resolving: identity, call: 1, to: lan)
    registered.value = [variant]

    await pathChangeKeepsTheCachedRoute(rig)
  }

  func test_anIdentityThatWasNeverRegisteredKeepsItsRouteAcrossAPathChange() async {
    let rig = makeRig(registered: LockedValue([]))
    await settle(rig, resolving: identity, call: 1, to: lan)

    await pathChangeKeepsTheCachedRoute(rig)
  }

  func test_anIdentityRegisteredUnderAVariantIsPrunedOnceItLeavesTheRegistry() async {
    let variant = URL(string: "http://PUBLIC.example.com/")!
    let registered = LockedValue([variant])
    let rig = makeRig(registered: registered)
    await settle(rig, resolving: identity, call: 1, to: lan)

    registered.value = []
    rig.paths.yield()
    let debounced = await rig.sleeps.waitForStarted(1, of: debounce)
    XCTAssertTrue(debounced)
    await rig.sleeps.release(debounce)
    let pruned = await pollUntil { rig.resolver.status(for: identity) == nil }
    XCTAssertTrue(pruned)
    XCTAssertEqual(rig.resolver.effectiveURL(for: identity), identity)
  }
}
