// LightTableView.swift
//
// The Light Table (#2121 F2): an ambient, self-cycling display of a
// warm-paper "prints laid out on a light table" scene — prints at scattered,
// gently-rotated positions, one gliding in from the right every few seconds
// while the oldest slides off. The table lays itself out quickly on open and
// only then settles into its ambient drift. Cycles forever with no
// interaction required.
//
// Shared by Maple TV's Light Table tab and the iPhone/iPad backup screen
// saver (#5457). Each platform supplies its own thumbnail pipeline through
// `prefetch` (fully fetch + decode before a print appears, so it glides in
// already rendered) and `printImage` (the photo inside the mat). On tvOS the
// Siri Remote can move focus onto any print, which raises it.

import SwiftUI

public enum LightTablePalette {
  public static let paperTop = Color(red: 0xfd / 255, green: 0xfc / 255, blue: 0xf9 / 255)
  public static let paperBottom = Color(red: 0xe6 / 255, green: 0xe1 / 255, blue: 0xd5 / 255)
  public static let ink = Color(red: 0x1c / 255, green: 0x19 / 255, blue: 0x17 / 255)
}

public struct LightTableView<PrintImage: View>: View {
  private let viewModel: LightTableViewModel
  private let fixedMetrics: LightTableMetrics?
  private let accent: Color
  private let prefetch: @MainActor (SearchAsset) async -> Void
  private let printImage: (SearchAsset) -> PrintImage

  @State private var stageSize: CGSize?
  @State private var stage: [StagePrint] = []
  /// Per-print removal timers, keyed by print id — each print schedules its
  /// OWN slide-off after `cardLifetime`, independent of when others were
  /// added, so prints don't animate in coupled add-one/remove-one pairs.
  @State private var removalTasks: [UUID: Task<Void, Never>] = [:]
  /// A plain (unstructured) `Task`, not a child of the `.task` that seeds the
  /// stage: it must outlive that closure, so `.onDisappear` cancels it.
  @State private var cycleTask: Task<Void, Never>?
  /// The Retry button's in-flight reload, cancelled on disappear so a reload
  /// resolving off-screen can't start a glide loop nothing will cancel.
  @State private var retryTask: Task<Void, Never>?
  /// Ever-increasing stacking counter — see `StagePrint.z`.
  @State private var spawnSeq: Double = 0
  @FocusState private var focusedPrintID: UUID?
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

  /// - Parameter metrics: fixed stage geometry, or nil to fit the container.
  public init(
    viewModel: LightTableViewModel,
    metrics: LightTableMetrics? = nil,
    accent: Color,
    prefetch: @escaping @MainActor (SearchAsset) async -> Void,
    @ViewBuilder printImage: @escaping (SearchAsset) -> PrintImage
  ) {
    self.viewModel = viewModel
    self.fixedMetrics = metrics
    self.accent = accent
    self.prefetch = prefetch
    self.printImage = printImage
  }

  private struct StagePrint: Identifiable {
    let id = UUID()
    let asset: SearchAsset
    /// Where this print settles, in normalised stage coordinates.
    let anchor: CGPoint
    let rotation: Angle
    /// Monotonic stacking order — a freshly gliding-in print always sits on
    /// top of the ones already settled.
    let z: Double
    /// A little random X/Y/Z tilt the print carries as it "falls" into
    /// place — a leaf-like 3D settle that resolves to flat once landed.
    let fallX: Double
    let fallY: Double
    let fallZ: Double
  }

  private static var spawnInterval: Duration { .seconds(2.5) }
  /// Fast enough on first open that filling the table reads as a deliberate
  /// drift rather than a slow load.
  private static var fillInterval: Duration { .seconds(0.55) }
  private static var reducedMotionSpawnInterval: Duration { .seconds(6) }
  private static var errorRetryDelay: Duration { .seconds(30) }

  /// Maple TV keeps its original motion; phone and tablet honour Reduce
  /// Motion with a cross-fade and a slower cadence.
  private var reduceMotion: Bool {
    #if os(tvOS)
      false
    #else
      systemReduceMotion
    #endif
  }
  /// Randomised so the opening burst of prints doesn't expire together and
  /// empty the table in waves.
  private static func cardLifetime() -> Duration {
    .seconds(.random(in: 18...34))
  }

  public var body: some View {
    ZStack {
      LinearGradient(
        colors: [LightTablePalette.paperTop, LightTablePalette.paperBottom],
        startPoint: .top, endPoint: .bottom
      )
      .ignoresSafeArea()
      GeometryReader { proxy in
        content(fixedMetrics ?? .fitting(proxy.size))
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .onAppear { stageSize = proxy.size }
          .onChange(of: proxy.size) { _, size in stageSize = size }
      }
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
      viewModel.cancelRefresh()
    }
  }

  // MARK: - Content states

  private var cycleMetrics: LightTableMetrics? {
    fixedMetrics ?? stageSize.map(LightTableMetrics.fitting)
  }

  @ViewBuilder
  private func content(_ metrics: LightTableMetrics) -> some View {
    if viewModel.isLoading, stage.isEmpty {
      loadingView
    } else if let error = viewModel.loadError, stage.isEmpty {
      errorView(error, metrics)
    } else if viewModel.pool.isEmpty, !viewModel.isLoading {
      emptyView(metrics)
    } else {
      stageView(metrics)
    }
  }

  private var loadingView: some View {
    ProgressView("Loading the Light Table…")
      .tint(LightTablePalette.ink)
      .foregroundStyle(LightTablePalette.ink)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityLabel("Loading the Light Table")
  }

  private func errorView(_ error: Error, _ metrics: LightTableMetrics) -> some View {
    VStack(spacing: 16) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: metrics.iconSize))
        .foregroundStyle(accent)
        .accessibilityHidden(true)
      Text("Couldn't load the Light Table")
        .font(.system(size: metrics.titleSize, weight: .semibold))
        .foregroundStyle(LightTablePalette.ink)
      Text(error.localizedDescription)
        .font(.system(size: metrics.bodySize))
        .foregroundStyle(LightTablePalette.ink.opacity(0.65))
        .multilineTextAlignment(.center)
        .frame(maxWidth: metrics.messageWidth)
      #if os(tvOS)
        Button("Retry") {
          retryTask?.cancel()
          retryTask = Task { await reload() }
        }
        .accessibilityLabel("Retry loading the Light Table")
      #endif
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    #if !os(tvOS)
      // A touch dismisses the screen saver before a button could take it,
      // so retry on a timer instead.
      .task {
        try? await Task.sleep(for: Self.errorRetryDelay)
        guard !Task.isCancelled else { return }
        await reload()
      }
    #endif
  }

  private func emptyView(_ metrics: LightTableMetrics) -> some View {
    VStack(spacing: 16) {
      Image(systemName: "rectangle.grid.2x2")
        .font(.system(size: metrics.iconSize))
        .foregroundStyle(LightTablePalette.ink.opacity(0.4))
        .accessibilityHidden(true)
      Text("Nothing to show yet")
        .font(.system(size: metrics.titleSize, weight: .semibold))
        .foregroundStyle(LightTablePalette.ink)
      Text("Pick or rate some photos to fill the Light Table.")
        .font(.system(size: metrics.captionSize))
        .foregroundStyle(LightTablePalette.ink.opacity(0.6))
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Nothing to show yet — pick or rate some photos to fill the Light Table")
  }

  private func stageView(_ metrics: LightTableMetrics) -> some View {
    ZStack {
      ForEach(stage) { print in
        LightTablePrintCard(
          imageSize: metrics.imageSize, matPadding: metrics.matPadding, accent: accent
        ) {
          printImage(print.asset)
        }
        .offset(metrics.offset(for: print.anchor))
        .rotationEffect(print.rotation)
        .zIndex(print.z)
        #if os(tvOS)
          .focusable()
          .focused($focusedPrintID, equals: print.id)
        #endif
        .accessibilityLabel(Self.accessibilityLabel(for: print.asset))
        // Falls in from off the right with a little X/Y/Z tilt that settles
        // to flat, then after its lifetime slides off the left edge (offset
        // additive to its settled position). Pure motion, no opacity fade.
        .transition(reduceMotion ? .opacity : Self.fall(of: print, metrics: metrics))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private static func fall(of print: StagePrint, metrics: LightTableMetrics) -> AnyTransition {
    .asymmetric(
      insertion: .modifier(
        active: PrintFall(dx: metrics.entryOffset, x: print.fallX, y: print.fallY, z: print.fallZ),
        identity: PrintFall.settled),
      removal: .modifier(
        active: PrintFall(dx: -metrics.exitOffset, x: -print.fallX, y: print.fallY, z: print.fallZ),
        identity: PrintFall.settled))
  }

  // MARK: - Accessibility

  private static func accessibilityLabel(for asset: SearchAsset) -> String {
    let rating = asset.rating.flatMap { $0 > 0 ? ($0 == 1 ? "1 star" : "\($0) stars") : nil }
    let date = asset.captured_at
      .flatMap(parseTimelineISO8601)
      .map { $0.formatted(date: .abbreviated, time: .omitted) }
    return [asset.filename, rating, date].compactMap { $0 }.joined(separator: ", ")
  }

  // MARK: - Ambient cycle

  /// A slot no print currently occupies, chosen at random so the stage fills
  /// in unpredictably. Nil when every slot is taken — the spawn is skipped.
  private func freeSlot(in metrics: LightTableMetrics) -> Int? {
    let taken = Set(stage.map { metrics.slot(containing: $0.anchor) })
    return (0..<metrics.slotCount).filter { !taken.contains($0) }.randomElement()
  }

  /// Glide one fresh print into a free slot and schedule its own removal.
  private func spawnPrint() async {
    guard let metrics = cycleMetrics, let slot = freeSlot(in: metrics), let asset = viewModel.next()
    else { return }
    await prefetch(asset)
    guard !Task.isCancelled else { return }

    spawnSeq += 1
    // The fetch above suspends, and a print may have taken this slot meanwhile.
    guard !stage.contains(where: { metrics.slot(containing: $0.anchor) == slot }) else { return }
    let print = StagePrint(
      asset: asset, anchor: metrics.anchor(forSlot: slot),
      rotation: .degrees(.random(in: -8...8)),
      z: spawnSeq,
      fallX: .random(in: -12...12), fallY: .random(in: -12...12), fallZ: .random(in: -6...6))
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

  /// Spawns the first print immediately, then one per interval. A no-op when
  /// the pool is empty; the load/reload callers re-enter after a successful
  /// (re)load, so a Retry that finds content still starts it.
  private func startCycle() {
    stopCycle()
    guard !viewModel.pool.isEmpty else { return }
    cycleTask = Task {
      // `filling` latches off once the stage has been full, so the gaps that
      // open as prints expire refill at the ambient cadence.
      var filling = true
      while !Task.isCancelled {
        await spawnPrint()
        if filling, let metrics = cycleMetrics, stage.count >= metrics.slotCount { filling = false }
        try? await Task.sleep(for: nextSpawnDelay(filling: filling))
      }
    }
  }

  private func nextSpawnDelay(filling: Bool) -> Duration {
    switch (filling, reduceMotion) {
    case (true, _): return Self.fillInterval
    case (false, true): return Self.reducedMotionSpawnInterval
    case (false, false): return Self.spawnInterval
    }
  }

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
/// additive to the settled offset) plus a small 3D tilt that resolves to flat
/// (`.settled`) as the print lands. Used for both the fall-in and slide-off.
private struct PrintFall: ViewModifier {
  let dx: CGFloat
  let x: Double
  let y: Double
  let z: Double

  static let settled = PrintFall(dx: 0, x: 0, y: 0, z: 0)

  func body(content: Content) -> some View {
    content
      .rotation3DEffect(.degrees(x), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
      .rotation3DEffect(.degrees(y), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
      .rotationEffect(.degrees(z))
      .offset(x: dx)
  }
}

/// One scattered "print" — a photo on a white mat with a layered drop
/// shadow. Reads `\.isFocused` from the focusable modifier applied just
/// outside it, raising itself with an accent ring when focused (tvOS).
private struct LightTablePrintCard<Content: View>: View {
  let imageSize: CGFloat
  let matPadding: CGFloat
  let accent: Color
  @ViewBuilder let content: Content

  @Environment(\.isFocused) private var isFocused

  private var shadowScale: CGFloat { imageSize / LightTableMetrics.television.imageSize }

  var body: some View {
    content
      .frame(width: imageSize, height: imageSize)
      .padding(matPadding)
      .background(Color.white)
      .clipShape(RoundedRectangle(cornerRadius: 6))
      .overlay(
        RoundedRectangle(cornerRadius: 6)
          .stroke(accent, lineWidth: isFocused ? 6 : 0)
      )
      // A soft, wide ambient shadow plus a tighter key shadow, so the print
      // reads as a physical card lifted off the table. Tuned on Maple TV's
      // 300 pt prints and scaled with the print on smaller screens.
      .shadow(
        color: .black.opacity(isFocused ? 0.32 : 0.20),
        radius: (isFocused ? 44 : 22) * shadowScale, x: 0, y: (isFocused ? 26 : 13) * shadowScale
      )
      .shadow(
        color: .black.opacity(isFocused ? 0.24 : 0.16),
        radius: (isFocused ? 9 : 4) * shadowScale, x: 0, y: (isFocused ? 6 : 2) * shadowScale
      )
      .scaleEffect(isFocused ? 1.14 : 1.0)
      .animation(.easeOut(duration: 0.25), value: isFocused)
  }
}
