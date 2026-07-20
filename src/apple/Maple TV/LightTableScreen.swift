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
  /// Round-robins through `slots` as prints are added — see
  /// `advanceStage()`.
  @State private var nextSlotIndex = 0
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
    let slot: PrintSlot
  }

  private struct PrintSlot {
    let offset: CGSize
    let rotation: Angle
  }

  /// Six hand-placed positions/rotations, scattered around the stage
  /// center — a designed "photos laid out by hand" look rather than
  /// fully random placement every cycle. `advanceStage()` assigns the
  /// next print the next slot round-robin, so a slot's occupant changes
  /// every `slots.count` prints, which lines up exactly with when that
  /// print ages out of `maxOnStage` — the incoming print visually
  /// replaces the outgoing one in the same spot.
  private static let slots: [PrintSlot] = [
    PrintSlot(offset: CGSize(width: -460, height: -120), rotation: .degrees(-7)),
    PrintSlot(offset: CGSize(width: -210, height: 140), rotation: .degrees(6)),
    PrintSlot(offset: CGSize(width: 50, height: -170), rotation: .degrees(-5)),
    PrintSlot(offset: CGSize(width: 300, height: 90), rotation: .degrees(9)),
    PrintSlot(offset: CGSize(width: 470, height: -70), rotation: .degrees(-10)),
    PrintSlot(offset: CGSize(width: 90, height: 190), rotation: .degrees(4)),
  ]

  private static let maxOnStage = 6
  private static let glideInterval: Duration = .seconds(6)
  private static let lookAheadCount = 2

  private static let paperTop = Color(red: 0xfd / 255, green: 0xfc / 255, blue: 0xf9 / 255)
  private static let paperBottom = Color(red: 0xe6 / 255, green: 0xe1 / 255, blue: 0xd5 / 255)
  private static let ink = Color(red: 0x1c / 255, green: 0x19 / 255, blue: 0x17 / 255)

  var body: some View {
    ZStack {
      background
      content
      if let focusedAsset {
        captionOverlay(for: focusedAsset)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .task {
      await viewModel.load()
      guard !Task.isCancelled else { return }
      seedStage()
      await prefetchLookahead()
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
        let isFocused = focusedPrintID == print.id
        PrintCard(
          asset: print.asset,
          server: session.server,
          thumbClient: session.thumbClient,
          thumbCache: session.thumbCache
        )
        .offset(print.slot.offset)
        .rotationEffect(print.slot.rotation)
        .zIndex(isFocused ? 10 : 0)
        .focusable()
        .focused($focusedPrintID, equals: print.id)
        .accessibilityLabel(Self.accessibilityLabel(for: print.asset))
        // Prints glide in from the right and slide out to the LEFT — a
        // conveyor of photos — rather than fading. Pure moves, no opacity,
        // so a print never fades away in place.
        .transition(.asymmetric(
          insertion: .move(edge: .trailing),
          removal: .move(edge: .leading)
        ))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Caption

  private var focusedAsset: SearchAsset? {
    stage.first(where: { $0.id == focusedPrintID })?.asset
  }

  /// Visual-only, screen-centered caption bar — mirrors
  /// `PhotoViewerScreen.captionOverlay`'s shape (bottom bar, hidden from
  /// the accessibility tree because the print's own `accessibilityLabel`
  /// already carries the same information) but centered rather than
  /// leading-aligned, and warm-paper toned instead of dark-chrome toned.
  /// Deliberately fixed to the bottom of the screen rather than anchored
  /// under the print's own scattered/rotated frame — an edge-slotted
  /// print's caption would otherwise clip off-screen or inherit an
  /// awkward rotation.
  private func captionOverlay(for asset: SearchAsset) -> some View {
    VStack {
      Spacer()
      VStack(spacing: 6) {
        Text(asset.filename)
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(Self.ink)
          .lineLimit(1)
          .truncationMode(.middle)

        HStack(spacing: 16) {
          if let rating = asset.rating, rating > 0 {
            HStack(spacing: 2) {
              ForEach(0..<rating, id: \.self) { _ in
                Image(systemName: "star.fill")
                  .font(.system(size: 14))
                  .foregroundStyle(MapleTVTheme.star)
              }
            }
          }
          if let dateText = Self.captureDateText(asset.captured_at) {
            Text(dateText)
              .font(.system(size: 17))
              .foregroundStyle(Self.ink.opacity(0.65))
          }
        }
      }
      .multilineTextAlignment(.center)
      .padding(.vertical, 28)
      .frame(maxWidth: .infinity)
      .background(Self.paperTop.opacity(0.9))
    }
    .accessibilityHidden(true)
    .allowsHitTesting(false)
    .transition(.opacity)
    .animation(.easeOut(duration: 0.2), value: focusedPrintID)
  }

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

  private func seedStage() {
    let initialCount = min(3, Self.slots.count)
    for _ in 0..<initialCount {
      advanceStage()
    }
  }

  /// Pulls the next asset off `viewModel`'s cyclic pool and glides it
  /// into the next slot (round-robin), trimming the stage back down to
  /// `maxOnStage` — the print that ages out is whichever one occupies
  /// the front of `stage` once the cap is exceeded, which — because
  /// `slots.count == maxOnStage` — is always the print that most
  /// recently held THIS SAME slot. A no-op when the pool is empty.
  private func advanceStage() {
    guard let asset = viewModel.next() else { return }
    let slot = Self.slots[nextSlotIndex]
    nextSlotIndex = (nextSlotIndex + 1) % Self.slots.count
    withAnimation(.easeInOut(duration: 1.1)) {
      stage.append(StagePrint(asset: asset, slot: slot))
      if stage.count > Self.maxOnStage {
        stage.removeFirst(stage.count - Self.maxOnStage)
      }
    }
  }

  /// Starts the repeating glide-in timer as a stored, explicitly
  /// cancellable `Task` — see `cycleTask`'s doc comment. Re-checks
  /// `Task.isCancelled` after every sleep so a cancellation mid-sleep
  /// never fires one more `advanceStage()`.
  ///
  /// No-ops when the pool is empty (empty library / load error): there's
  /// nothing to glide, so spinning a timer that wakes every
  /// `glideInterval` only to run a no-op `advanceStage()` is pure waste
  /// while the empty/error state is shown. The `.task`/`reload()` callers
  /// re-enter here after a successful (re)load, so a Retry that finds
  /// content still starts the cycle.
  private func startCycle() {
    cycleTask?.cancel()
    guard !viewModel.pool.isEmpty else {
      cycleTask = nil
      return
    }
    cycleTask = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.glideInterval)
        guard !Task.isCancelled else { return }
        // Don't glide a print out from under the user while they're
        // examining one — a focused print is raised with its caption, and
        // aging it off the stage would yank focus to a neighbor mid-look.
        // Skip the advance until focus returns to the ambient (nil) state.
        // In screensaver mode nothing is focusable (`.disabled(true)`), so
        // `focusedPrintID` stays nil there and the cycle never pauses.
        guard focusedPrintID == nil else { continue }
        advanceStage()
        await prefetchLookahead()
      }
    }
  }

  private func stopCycle() {
    cycleTask?.cancel()
    cycleTask = nil
  }

  private func reload() async {
    await viewModel.load()
    guard !Task.isCancelled else { return }
    stage = []
    nextSlotIndex = 0
    seedStage()
    await prefetchLookahead()
    guard !Task.isCancelled else { return }
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
