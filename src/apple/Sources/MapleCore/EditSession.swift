// EditSession.swift — per-image transient editing state (spec § 01).
//
// Holds the current AdjustmentModel, undo/redo stacks, culling state,
// and render phase. Observable for SwiftUI.

import Foundation
import CoreImage
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// MARK: - RenderPhase

/// Two-phase rendering per spec § 02 / § 05.
public enum RenderPhase: Sendable, Equatable {
    /// Fast preview at reduced resolution (≤ 50ms target).
    case fast
    /// Full-resolution final render (≤ 300ms target).
    case refine
}

// MARK: - AssetRef

/// Lightweight reference to a source asset (raw URL + optional sidecar URL).
public struct AssetRef: Identifiable, Sendable, Equatable, Hashable {
    public let id: UUID
    public let primaryURL: URL
    public var sidecarURL: URL? {
        primaryURL.deletingPathExtension().appendingPathExtension("xmp")
    }
    public var displayName: String { primaryURL.deletingPathExtension().lastPathComponent }

    public init(url: URL) {
        self.id = UUID()
        self.primaryURL = url
    }
}

// MARK: - EditSession

/// Per-image editing session. Observed by SwiftUI via the `@Observable` macro;
/// use `@State` / `@Bindable` in views, not `@ObservedObject`.
@MainActor
@Observable
public final class EditSession {
    public let asset: AssetRef

    // MARK: Model

    public var model: AdjustmentModel {
        didSet {
            guard model != oldValue else { return }
            _scheduleRender(phase: .fast)
            Task { await sidecarStore.update(model: model, culling: culling) }
        }
    }
    public var culling: CullingState {
        didSet {
            Task { await sidecarStore.update(model: model, culling: culling) }
        }
    }

    /// Snapshot at session open — used by before/after toggle.
    public private(set) var originalModel: AdjustmentModel

    // MARK: Render output

    public var renderedPreview: CIImage?
    public var renderPhase: RenderPhase = .fast
    public var isRendering: Bool = false
    /// Last render error, if any. Views can surface a banner when non-nil.
    public var renderError: Error?

    // MARK: Zoom / pan

    public var zoomScale: Double = 1.0
    public var showingOriginal: Bool = false

    // MARK: Undo / redo

    @ObservationIgnored private var undoStack: [AdjustmentModel] = []
    @ObservationIgnored private var redoStack: [AdjustmentModel] = []
    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }

    // MARK: Internals

    @ObservationIgnored private let pipeline: ImageEditPipeline
    @ObservationIgnored private let sidecarStore: XMPSidecarStore
    @ObservationIgnored private var renderTask: Task<Void, Never>?
    @ObservationIgnored private var refineTask: Task<Void, Never>?
    /// Bumped on every render schedule so that stale tasks exit before writing UI state.
    @ObservationIgnored private var renderGeneration: UInt64 = 0

    // MARK: Init

    public init(asset: AssetRef,
                model: AdjustmentModel = .default,
                culling: CullingState = CullingState()) {
        self.asset = asset
        self.model = model
        self.originalModel = model
        self.culling = culling
        self.pipeline = ImageEditPipeline()
        self.sidecarStore = XMPSidecarStore(rawURL: asset.primaryURL)
    }

    // MARK: - Public API

    /// Push the current model to the undo stack before a user gesture.
    public func beginEdit() {
        undoStack.append(model)
        redoStack.removeAll()
    }

    public func undo() {
        guard let prev = undoStack.popLast() else { return }
        redoStack.append(model)
        model = prev
    }

    public func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(model)
        model = next
    }

    public func resetToOriginal() {
        beginEdit()
        model = originalModel
    }

    /// Load model + culling from disk; call once after init.
    public func loadSidecar() async {
        guard let (m, c) = try? await sidecarStore.load() else { return }
        originalModel = m
        model = m
        culling = c
    }

    /// Force a full-resolution render immediately (useful before export).
    public func renderFull() async {
        await _render(phase: .refine)
    }

    // MARK: - Private render scheduling

    private func _scheduleRender(phase: RenderPhase) {
        renderTask?.cancel()
        refineTask?.cancel()
        renderGeneration &+= 1
        let gen = renderGeneration
        renderTask = Task { @MainActor in
            await _render(phase: .fast, gen: gen)
            guard gen == renderGeneration, !Task.isCancelled else { return }
            refineTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(250))
                guard gen == renderGeneration, !Task.isCancelled else { return }
                await _render(phase: .refine, gen: gen)
            }
        }
    }

    private func _render(phase: RenderPhase, gen: UInt64? = nil) async {
        isRendering = true
        renderPhase = phase
        let m = model
        let asset = self.asset
        do {
            let image = try await Task.detached(priority: .userInitiated) {
                // `pipeline.render` currently returns `CIImage?` and does not
                // throw; convert nil into an error so views can surface it.
                guard let img = await self.pipeline.render(asset: asset, model: m, phase: phase) else {
                    throw RenderError.pipelineFailed
                }
                return img
            }.value
            // Reject stale results if the scheduler moved on.
            if let gen, gen != renderGeneration {
                isRendering = false
                return
            }
            renderedPreview = image
            renderError = nil
        } catch {
            if let gen, gen != renderGeneration {
                isRendering = false
                return
            }
            renderError = error
        }
        isRendering = false
    }
}

// MARK: - RenderError

/// Errors surfaced by `EditSession._render`.
public enum RenderError: Error, LocalizedError, Sendable {
    case pipelineFailed

    public var errorDescription: String? {
        switch self {
        case .pipelineFailed:
            return "Failed to render preview."
        }
    }
}
