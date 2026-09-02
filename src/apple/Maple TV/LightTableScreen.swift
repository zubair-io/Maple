// src/apple/Maple TV/LightTableScreen.swift
import MapleCloudKit
import SwiftUI
import UIKit

/// The Light Table (#2121 F2): an ambient, self-cycling display of a
/// warm-paper "prints laid out on a light table" scene — `PrintCard`s at
/// scattered, gently-rotated positions, one gliding in from the right
/// every few seconds while the oldest fades out (capped at
/// `maxOnStage`). Positions come from a jittered grid of stage slots
/// rather than pure randomness, so a stage this full spreads across the
/// whole table instead of heaping in the middle. The table lays itself
/// out quickly on open and only then settles into its ambient drift. Cycles forever with no interaction required; the Siri
/// Remote can still move focus onto any print, which raises it (scale +
/// red focus ring) and surfaces a centered caption.
///
/// Unlike every other Maple TV screen, this one's background is the
/// design's warm paper gradient rather than `MapleTVTheme.background` —
/// a deliberate light surface distinct from the dark Timeline/Search
/// chrome (see `paperTop`/`paperBottom`/`ink` below).
struct LightTableScreen: View {
  let session: TVCloudSession
  let libraryID: String

  @State private var viewModel: LightTableViewModel
  @State private var stage: [StagePrint] = []
  /// Per-print removal timers, keyed by print id — each print schedules its
  /// OWN slide-off after `cardLifetime`, independent of when others were
  /// added, so prints don't animate in coupled add-one/remove-one pairs.
  /// Stored so `.onDisappear` cancels them all alongside `cycleTask`
  /// (Global Constraint: no leaked tasks).
  @State private var removalTasks: [UUID: Task<Void, Never>] = [:]
  /// The ambient timer loop. A plain (unstructured) `Task`, NOT a child
  /// of the initial `.task` closure that seeds the stage — it must
  /// outlive that closure's return, so it's stored and explicitly
  /// cancelled `onDisappear` rather than relying on `.task`'s automatic
  /// cancellation (Global Constraint: timer/tasks must not leak).
  @State private var cycleTask: Task<Void, Never>?
  /// The Retry button's in-flight `reload()`, stored so `.onDisappear`
  /// can cancel it alongside `cycleTask`. Without this, tapping Retry
  /// then navigating away before the network round-trip resolves lets
  /// `reload()` run off-screen and call `startCycle()` after
  /// `.onDisappear` already fired — spinning up a repeating glide timer
  /// nothing will ever cancel (F2 review).
  @State private var retryTask: Task<Void, Never>?
  @FocusState private var focusedPrintID: UUID?

  init(session: TVCloudSession, libraryID: String) {
    self.session = session
    self.libraryID = libraryID
    _viewModel = State(initialValue: LightTableViewModel(
      libraryID: libraryID,
      searchClient: session.searchClient,
      generatedSearchClient: session.generatedSearchClient
    ))
  }

  private struct StagePrint: Identifiable {
    let id = UUID()
    let asset: SearchAsset
    /// Where this print settles (offset from stage center) and a slight
    /// rotation — both randomized per print so the scatter looks hand-laid.
    let position: CGSize
    let rotation: Angle
    /// Monotonic stacking order — the most recently spawned print gets the
    /// highest value, so a freshly gliding-in print always sits on top of
    /// the ones already settled.
    let z: Double
    /// A little random X/Y/Z tilt the print carries as it "falls" into
    /// place — a leaf-like 3D settle rather than a flat slide. Resolves to
    /// zero once settled.
    let fallX: Double
    let fallY: Double
    let fallZ: Double
    /// Which stage slot this print occupies — see `slotPosition(_:)`. Held so
    /// a new print can pick a slot nothing is currently sitting in.
    let slot: Int
  }

  /// Ever-increasing stacking counter — see `StagePrint.z`.
  @State private var spawnSeq: Double = 0

  /// How often a new print glides in, once the table is laid out.
  private static let spawnInterval: Duration = .seconds(2.5)
  /// How often prints glide in while the table is still filling for the first
  /// time. At the ambient cadence a full stage took nearly half a minute to
  /// assemble, which read as the screen being slow to load rather than as a
  /// deliberate drift.
  private static let fillInterval: Duration = .seconds(0.55)
  /// How long a print lingers before it slides off, randomised per print.
  /// A range rather than a constant because the opening fill spawns a dozen
  /// prints within a few seconds: on a fixed lifetime they would all expire
  /// together and the table would visibly empty and refill in waves. Spread
  /// lifetimes desynchronise the removals from the very first cycle.
  private static func cardLifetime() -> Duration {
    .seconds(.random(in: 18...34))
  }
  /// Safety cap so a burst can't overcrowd the stage (the lifetime already
  /// self-regulates the steady-state count). One per slot.
  private static let maxOnStage = slotColumns * slotRows

  // MARK: - Stage slots

  /// The stage is a coarse grid of slots, and a print settles into one of
  /// them (jittered, so the grid never reads as a grid). Purely random
  /// positions let prints pile on top of each other — with more prints on
  /// stage that stops being an occasional charming overlap and becomes a
  /// heap in the middle with bare corners. Choosing an unoccupied slot
  /// spreads them over the whole table instead.
  private static let slotColumns = 4
  private static let slotRows = 3
  /// Half-extent of the area slot centres are spread across. Kept inside the
  /// screen by roughly half a print (plus its focus scale and shadow) so a
  /// print in an edge slot is never clipped.
  private static let stageHalfWidth: CGFloat = 660
  private static let stageHalfHeight: CGFloat = 340
  /// How far a print may sit from its slot centre. Well under the slot pitch,
  /// so neighbouring prints overlap a little — they should still read as
  /// prints casually laid on a table, not cells in a grid — without
  /// collapsing into each other.
  private static let slotJitter: CGFloat = 60

  /// Centre of `slot`, plus a random jitter.
  private static func slotPosition(_ slot: Int) -> CGSize {
    let column = slot % slotColumns
    let row = slot / slotColumns
    // Spread column/row centres evenly across the stage: for N columns the
    // centres sit at the midpoints of N equal bands, so the outermost are
    // inset by half a band rather than pinned to the edge.
    let columnFraction = (Double(column) + 0.5) / Double(slotColumns)
    let rowFraction = (Double(row) + 0.5) / Double(slotRows)
    let x = (columnFraction * 2 - 1) * stageHalfWidth
    let y = (rowFraction * 2 - 1) * stageHalfHeight
    return CGSize(
      width: x + .random(in: -slotJitter...slotJitter),
      height: y + .random(in: -slotJitter...slotJitter)
    )
  }

  /// A slot no print currently occupies, chosen at random so the stage fills
  /// in unpredictably rather than left-to-right. Returns nil when every slot
  /// is taken — the caller then skips this spawn rather than doubling up.
  private func freeSlot() -> Int? {
    let taken = Set(stage.map(\.slot))
    return (0..<Self.maxOnStage).filter { !taken.contains($0) }.randomElement()
  }
  private static func randomRotation() -> Angle {
    .degrees(.random(in: -8...8))
  }

  private static let paperTop = Color(red: 0xfd / 255, green: 0xfc / 255, blue: 0xf9 / 255)
  private static let paperBottom = Color(red: 0xe6 / 255, green: 0xe1 / 255, blue: 0xd5 / 255)
  private static let ink = Color(red: 0x1c / 255, green: 0x19 / 255, blue: 0x17 / 255)

  var body: some View {
    ZStack {
      background
      content
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .task {
      await viewModel.load()
      guard !Task.isCancelled else { return }
      startCycle()
    }
    .onAppear {
      // The Light Table is a deliberately no-interaction ambient view, so
      // tvOS would otherwise judge the box "idle" and drop its own system
      // screensaver over Maple. Hold the idle timer off while it's showing.
      UIApplication.shared.isIdleTimerDisabled = true
    }
    .onDisappear {
      UIApplication.shared.isIdleTimerDisabled = false
      stopCycle()
      retryTask?.cancel()
      retryTask = nil
      viewModel.cancelRefresh()
    }
  }

  // MARK: - Background

  private var background: some View {
    LinearGradient(colors: [Self.paperTop, Self.paperBottom], startPoint: .top, endPoint: .bottom)
      .ignoresSafeArea()
  }

  // MARK: - Content states

  @ViewBuilder
  private var content: some View {
    if viewModel.isLoading, stage.isEmpty {
      loadingView
    } else if let error = viewModel.loadError, stage.isEmpty {
      errorView(error)
    } else if viewModel.pool.isEmpty, !viewModel.isLoading {
      emptyView
    } else {
      stageView
    }
  }

  private var loadingView: some View {
    ProgressView("Loading the Light Table…")
      .tint(Self.ink)
      .foregroundStyle(Self.ink)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityLabel("Loading the Light Table")
  }

  private func errorView(_ error: Error) -> some View {
    VStack(spacing: 16) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: 56))
        .foregroundStyle(MapleTVTheme.primary)
        .accessibilityHidden(true)
      Text("Couldn't load the Light Table")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(Self.ink)
      Text(error.localizedDescription)
        .font(.system(size: 20))
        .foregroundStyle(Self.ink.opacity(0.65))
        .multilineTextAlignment(.center)
        .frame(maxWidth: 560)
      Button("Retry") {
        retryTask?.cancel()
        retryTask = Task { await reload() }
      }
      .accessibilityLabel("Retry loading the Light Table")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var emptyView: some View {
    VStack(spacing: 16) {
      Image(systemName: "rectangle.grid.2x2")
        .font(.system(size: 56))
        .foregroundStyle(Self.ink.opacity(0.4))
        .accessibilityHidden(true)
      Text("Nothing to show yet")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(Self.ink)
      Text("Pick or rate some photos to fill the Light Table.")
        .font(.system(size: 18))
        .foregroundStyle(Self.ink.opacity(0.6))
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Nothing to show yet — pick or rate some photos to fill the Light Table")
  }

  private var stageView: some View {
    ZStack {
      ForEach(stage) { print in
        PrintCard(
          asset: print.asset,
          server: session.server,
          thumbClient: session.thumbClient,
          thumbCache: session.thumbCache
        )
        .offset(print.position)
        .rotationEffect(print.rotation)
        // Newest print on top (see `StagePrint.z`) — a gliding-in print
        // always covers the ones already settled.
        .zIndex(print.z)
        .focusable()
        .focused($focusedPrintID, equals: print.id)
        .accessibilityLabel(Self.accessibilityLabel(for: print.asset))
        // A print falls in from off the right — a horizontal slide plus a
        // little X/Y/Z tilt that settles to flat, like a leaf — then, after
        // its `cardLifetime`, slides all the way off the LEFT edge (offset
        // additive to its settled `.offset(position)`, so it clears the
        // screen from wherever it landed). Pure motion, no opacity fade.
        .transition(.asymmetric(
          insertion: .modifier(
            active: PrintFall(dx: 1100, x: print.fallX, y: print.fallY, z: print.fallZ),
            identity: PrintFall.settled),
          removal: .modifier(
            active: PrintFall(dx: -2200, x: -print.fallX, y: print.fallY, z: print.fallZ),
            identity: PrintFall.settled)
        ))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Accessibility

  private static func accessibilityLabel(for asset: SearchAsset) -> String {
    var parts = [asset.filename]
    if let rating = asset.rating, rating > 0 {
      parts.append(rating == 1 ? "1 star" : "\(rating) stars")
    }
    if let dateText = captureDateText(asset.captured_at) {
      parts.append(dateText)
    }
    return parts.joined(separator: ", ")
  }

  private static func captureDateText(_ isoString: String?) -> String? {
    guard let isoString, let date = parseTimelineISO8601(isoString) else { return nil }
    return date.formatted(date: .abbreviated, time: .omitted)
  }

  // MARK: - Ambient cycle

  /// Glide one fresh print in at a random settle position, and schedule its
  /// own removal after `cardLifetime`. Spawning and removing are decoupled
  /// (each print has its own removal timer) so prints never animate in
  /// coupled add-one/remove-one pairs. A no-op when the pool is empty or the
  /// stage is already at its safety cap.
  private func spawnPrint() async {
    guard let slot = freeSlot(), let asset = viewModel.next() else { return }
    // Fully fetch + decode the thumbnail BEFORE the print appears, so it
    // glides in already-rendered instead of flickering from a loading tile
    // (holds the print "offscreen" — i.e. unspawned — until it's ready).
    await TVRemoteImage.prefetchThumb(
      server: session.server, absPath: asset.abs_path,
      thumbClient: session.thumbClient, thumbCache: session.thumbCache)
    guard !Task.isCancelled else { return }

    spawnSeq += 1
    // Re-check the slot: the fetch above suspends, and a print may have
    // taken this slot while it was in flight.
    guard !stage.contains(where: { $0.slot == slot }) else { return }
    let print = StagePrint(
      asset: asset, position: Self.slotPosition(slot), rotation: Self.randomRotation(),
      z: spawnSeq,
      fallX: .random(in: -12...12), fallY: .random(in: -12...12), fallZ: .random(in: -6...6),
      slot: slot)
    let id = print.id
    withAnimation(.easeOut(duration: 1.7)) {
      stage.append(print)
    }
    removalTasks[id] = Task {
      try? await Task.sleep(for: Self.cardLifetime())
      guard !Task.isCancelled else { return }
      withAnimation(.easeIn(duration: 1.5)) {
        stage.removeAll { $0.id == id }
      }
      removalTasks[id] = nil
    }
  }

  /// Starts the ambient spawn loop as a stored, explicitly cancellable
  /// `Task` — spawns the first print immediately, then one every
  /// `spawnInterval`. No-ops when the pool is empty (empty library / load
  /// error); the `.task`/`reload()` callers re-enter after a successful
  /// (re)load, so a Retry that finds content still starts it.
  private func startCycle() {
    stopCycle()
    guard !viewModel.pool.isEmpty else { return }
    cycleTask = Task {
      // Lay the table quickly the first time, then drift. `filling` latches
      // off once the stage has been full, so the gaps that open up as prints
      // expire are refilled at the ambient cadence, not the fill one.
      var filling = true
      while !Task.isCancelled {
        await spawnPrint()
        if filling, stage.count >= Self.maxOnStage { filling = false }
        try? await Task.sleep(for: filling ? Self.fillInterval : Self.spawnInterval)
      }
    }
  }

  /// Cancels the spawn loop and every pending per-print removal timer.
  private func stopCycle() {
    cycleTask?.cancel()
    cycleTask = nil
    for task in removalTasks.values { task.cancel() }
    removalTasks.removeAll()
  }

  private func reload() async {
    await viewModel.load()
    guard !Task.isCancelled else { return }
    stopCycle()
    stage = []
    startCycle()
  }

}

/// Transition modifier for a print's "leaf fall": a horizontal slide (`dx`,
/// additive to the print's settled offset) plus a small 3D tilt — X and Y
/// rotations for depth, a little extra Z spin — that all resolve to flat
/// (`.settled`) as the print lands. Used for both the fall-in and slide-off.
private struct PrintFall: ViewModifier {
  let dx: CGFloat
  let x: Double
  let y: Double
  let z: Double

  /// The landed / identity state — no offset, no tilt.
  static let settled = PrintFall(dx: 0, x: 0, y: 0, z: 0)

  func body(content: Content) -> some View {
    content
      .rotation3DEffect(.degrees(x), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
      .rotation3DEffect(.degrees(y), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
      .rotationEffect(.degrees(z))
      .offset(x: dx)
  }
}

/// One scattered "print" — a thumbnail on a white mat with a drop
/// shadow, reacting to its own focus state (raised scale + red ring).
/// Reads `\.isFocused` from the nearest focusable ancestor, which
/// `LightTableScreen.stageView` applies just outside this view (mirrors
/// `TimelineCell`/`TimelineCellCard`'s split for the same reason).
private struct PrintCard: View {
  let asset: SearchAsset
  let server: URL
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache

  @Environment(\.isFocused) private var isFocused

  private static let imageSize: CGFloat = 300
  private static let matPadding: CGFloat = 16

  var body: some View {
    TVRemoteImage(
      server: server,
      absPath: asset.abs_path,
      kind: .thumb,
      thumbClient: thumbClient,
      thumbCache: thumbCache,
      // Keep the photo's original aspect ratio — no crop-to-fill. The print
      // is a fixed square, so non-square photos sit within it on the white
      // mat rather than being cropped to the frame.
      contentMode: .fit,
      accessibilityLabel: asset.filename
    )
    .frame(width: Self.imageSize, height: Self.imageSize)
    .padding(Self.matPadding)
    .background(Color.white)
    .clipShape(RoundedRectangle(cornerRadius: 6))
    .overlay(
      RoundedRectangle(cornerRadius: 6)
        .stroke(MapleTVTheme.primary, lineWidth: isFocused ? 6 : 0)
    )
    // Material-style layered elevation: a soft, wide ambient shadow plus a
    // tighter key shadow, so the print reads as a physical card lifted off
    // the table. Both deepen when the print is focused (raised higher).
    .shadow(color: .black.opacity(isFocused ? 0.32 : 0.20),
            radius: isFocused ? 44 : 22, x: 0, y: isFocused ? 26 : 13)
    .shadow(color: .black.opacity(isFocused ? 0.24 : 0.16),
            radius: isFocused ? 9 : 4, x: 0, y: isFocused ? 6 : 2)
    .scaleEffect(isFocused ? 1.14 : 1.0)
    .animation(.easeOut(duration: 0.25), value: isFocused)
  }
}

// No `#Preview` here: `TVCloudSession` has no lightweight `.preview()`
// factory (real Keychain-backed token lookup) — matches
// `TimelineScreen`/`PhotoViewerScreen`, neither of which carry one for
// the same reason.
