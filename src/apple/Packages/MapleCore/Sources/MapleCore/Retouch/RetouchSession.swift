// RetouchSession.swift — the clone / heal editing session (#3409).
//
// Transient UI state (which spot is selected, what the brush is set to) plus
// the mutations that write `EditSession.model.retouchSpots`. The spots
// themselves live in the model, so undo/redo, the debounced sidecar write
// and the live render all follow from `EditSession`'s `model` `didSet` —
// one source of truth, the same rule every other tool obeys.
//
// Every commit is an `EditTransaction` of class `repair`, whose invalidation
// scope `InvalidationScope.classify` resolves to `.decode`: repair runs
// inside the decode product (`stages::retouch`), so the canvas re-decodes
// rather than re-running the per-tick chain, and `RawCoreBridge
// .stripAppleGPUStages` deliberately keeps the list so the #950 baked-model
// decode cache keys on it.
//
// Undo boundaries mirror the web `RetouchSessionService` and Apple's own
// mask surface: a DISCRETE edit (place, delete, mode change, reset) commits
// its own snapshot; a CONTINUOUS one (a canvas drag, a brush slider) opens a
// gesture with `beginGesture()` — idempotent, one commit per gesture — and
// closes it with `endGesture()` on release.

import Foundation

@MainActor
@Observable
public final class RetouchSession {
    private let session: EditSession

    /// The selected spot, or nil. Transient — never persisted.
    public var selectedSpotID: UUID?

    /// Brush defaults for the next placement. Editing one also rewrites the
    /// selected spot, so the panel reads as a brush rather than a per-spot
    /// form.
    public private(set) var brushKind: RetouchKind = .heal
    public private(set) var brushRadius: Double = RetouchSpot.defaultRadius
    public private(set) var brushFeather: Double = RetouchSpot.defaultFeather
    public private(set) var brushOpacity: Double = 1

    @ObservationIgnored private var gestureOpen = false

    public init(session: EditSession) { self.session = session }

    public var spots: [RetouchSpot] { session.model.retouchSpots }

    public var selected: RetouchSpot? {
        guard let selectedSpotID else { return nil }
        return session.model.retouchSpots.first { $0.id == selectedSpotID }
    }

    /// Select a spot and load its shape into the brush, so the panel's
    /// sliders describe what is on screen rather than a stale default.
    public func select(_ id: UUID?) {
        endGesture()
        selectedSpotID = id
        guard let spot = selected else { return }
        brushKind = spot.kind
        brushRadius = spot.radius
        brushFeather = spot.feather
        brushOpacity = spot.opacity
    }

    /// Place a spot centred on `center` with the current brush, select it,
    /// and return it.
    @discardableResult
    public func place(at center: RetouchPoint) -> RetouchSpot {
        endGesture()
        commit("Heal")
        let spot = RetouchSpot(
            kind: brushKind,
            center: center,
            source: RetouchOverlayGeometry.defaultSource(for: center, radius: brushRadius),
            radius: brushRadius,
            feather: brushFeather,
            opacity: brushOpacity)
        session.model.retouchSpots.append(spot)
        selectedSpotID = spot.id
        return spot
    }

    public func delete(_ id: UUID) {
        guard let index = session.model.retouchSpots.firstIndex(where: { $0.id == id })
        else { return }
        endGesture()
        commit("Delete spot")
        session.model.retouchSpots.remove(at: index)
        let remaining = session.model.retouchSpots
        selectedSpotID =
            remaining.isEmpty ? nil : remaining[min(index, remaining.count - 1)].id
    }

    /// Drop every spot on the image.
    public func resetAll() {
        guard !session.model.retouchSpots.isEmpty else { return }
        endGesture()
        commit("Reset heal")
        session.model.retouchSpots = []
        selectedSpotID = nil
    }

    /// Open a continuous gesture: commits ONE undo snapshot per gesture.
    public func beginGesture() {
        guard !gestureOpen else { return }
        commit("Heal")
        gestureOpen = true
    }

    public func endGesture() { gestureOpen = false }

    /// Rewrite the selected spot. `discrete` edits commit their own entry;
    /// continuous ones ride the open gesture (opening it if needed).
    public func updateSelected(discrete: Bool, _ transform: (RetouchSpot) -> RetouchSpot) {
        guard let id = selectedSpotID,
              let index = session.model.retouchSpots.firstIndex(where: { $0.id == id })
        else { return }
        // Decide whether anything changes BEFORE touching the undo stack, so
        // a redundant write pushes nothing.
        let next = transform(session.model.retouchSpots[index])
        guard next != session.model.retouchSpots[index] else { return }
        if discrete {
            endGesture()
            commit("Heal")
        } else {
            beginGesture()
        }
        session.model.retouchSpots[index] = next
    }

    public func setShape(_ spot: RetouchSpot) {
        updateSelected(discrete: false) { _ in spot }
    }

    public func setKind(_ kind: RetouchKind) {
        brushKind = kind
        updateSelected(discrete: true) { spot in
            var out = spot
            out.kind = kind
            return out
        }
    }

    public func setRadius(_ radius: Double) {
        brushRadius = radius
        updateSelected(discrete: false) { spot in
            var out = spot
            out.radius = radius
            return out
        }
    }

    public func setFeather(_ feather: Double) {
        brushFeather = feather
        updateSelected(discrete: false) { spot in
            var out = spot
            out.feather = feather
            return out
        }
    }

    public func setOpacity(_ opacity: Double) {
        brushOpacity = opacity
        updateSelected(discrete: false) { spot in
            var out = spot
            out.opacity = opacity
            return out
        }
    }

    /// Every repair edit is one `repair`-class transaction (#3409).
    private func commit(_ description: String) {
        session.beginEdit(kind: .repair, description: description)
    }
}
