// src/apple/Maple TV/LightTableScreen.swift
import MapleCloudKit
import SwiftUI

/// The Light Table (#2121 F2): an ambient, self-cycling display of a
/// warm-paper "prints laid out on a light table" scene — `PrintCard`s at
/// scattered, gently-rotated positions, one gliding in from the right
/// every few seconds while the oldest fades out (capped at
/// `maxOnStage`). Cycles forever with no interaction required; the Siri
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
      searchClient: session.searchClient
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
  }

  /// Ever-increasing stacking counter — see `StagePrint.z`.
  @State private var spawnSeq: Double = 0

  /// How often a new print glides in.
  private static let spawnInterval: Duration = .seconds(3.5)
  /// How long a print lingers before it slides off. Longer than
  /// `spawnInterval`, so several prints coexist (≈ lifetime / interval ≈ 4),
  /// each on its own in → settle → out lifecycle.
  private static let cardLifetime: Duration = .seconds(15)
  /// Safety cap so a burst can't overcrowd the stage (the lifetime already
  /// self-regulates the steady-state count).
  private static let maxOnStage = 6
  private static let lookAheadCount = 2

  /// Random settle position, kept within a margin so the whole print is
  /// on-screen (fully visible before it slides off).
  private static func randomPosition() -> CGSize {
    CGSize(width: .random(in: -480...480), height: .random(in: -230...230))
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
    .onDisappear {
      stopCycle()
      retryTask?.cancel()
      retryTask = nil
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
        // A print slides in from off the right to its settle position, then —
        // after its own `cardLifetime` — slides all the way off the LEFT edge
        // before it's removed. Explicit offsets (added to the print's static
        // `.offset(position)`) so the exit clears the screen from wherever it
        // settled, instead of vanishing in place. Pure slides, no fade.
        .transition(.asymmetric(
          insertion: .offset(x: 1100),
          removal: .offset(x: -2200)
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
  private func spawnPrint() {
    guard stage.count < Self.maxOnStage, let asset = viewModel.next() else { return }
    spawnSeq += 1
    let print = StagePrint(asset: asset, position: Self.randomPosition(),
                           rotation: Self.randomRotation(), z: spawnSeq)
    let id = print.id
    withAnimation(.easeOut(duration: 1.6)) {
      stage.append(print)
    }
    removalTasks[id] = Task {
      try? await Task.sleep(for: Self.cardLifetime)
      guard !Task.isCancelled else { return }
      withAnimation(.easeIn(duration: 1.6)) {
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
      while !Task.isCancelled {
        spawnPrint()
        await prefetchLookahead()
        try? await Task.sleep(for: Self.spawnInterval)
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

  /// Warms `CloudThumbCache`'s disk tier for the next couple of assets
  /// the cycle is about to show, so their `TVRemoteImage(.thumb)` glide
  /// in already-cached instead of showing a blank/loading tile while the
  /// network fetch runs. Best-effort: a fetch failure here just means
  /// the eventual real `TVRemoteImage` retries and surfaces its own
  /// `.failed` phase, same as `TVRemoteImage.prefetchPreview`.
  private func prefetchLookahead() async {
    let upcoming = viewModel.peekUpcoming(count: Self.lookAheadCount)
    guard !upcoming.isEmpty else { return }
    let server = session.server
    let thumbClient = session.thumbClient
    let thumbCache = session.thumbCache
    await withTaskGroup(of: Void.self) { group in
      for asset in upcoming {
        group.addTask {
          let host = server.cacheHostKey
          if await thumbCache.get(host: host, absPath: asset.abs_path) != nil { return }
          guard let bytes = try? await thumbClient.thumb(absPath: asset.abs_path) else { return }
          guard !Task.isCancelled else { return }
          await thumbCache.put(host: host, absPath: asset.abs_path, bytes)
        }
      }
    }
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
      kind: .thumb(size: 512),
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
    .shadow(
      color: .black.opacity(isFocused ? 0.4 : 0.22),
      radius: isFocused ? 30 : 14,
      x: 0,
      y: isFocused ? 20 : 10
    )
    .scaleEffect(isFocused ? 1.14 : 1.0)
    .animation(.easeOut(duration: 0.25), value: isFocused)
  }
}

// No `#Preview` here: `TVCloudSession` has no lightweight `.preview()`
// factory (real Keychain-backed token lookup) — matches
// `TimelineScreen`/`PhotoViewerScreen`, neither of which carry one for
// the same reason.
