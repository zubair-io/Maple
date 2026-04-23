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

/// Per-image editing session. Use `@StateObject` or `@ObservedObject` in views.
@MainActor
public final class EditSession: ObservableObject {
    public let asset: AssetRef

    // MARK: Model

    @Published public var model: AdjustmentModel {
        didSet {
            guard model != oldValue else { return }
            _scheduleRender(phase: .fast)
            Task { await sidecarStore.update(model: model, culling: culling) }
        }
    }
    @Published public var culling: CullingState {
        didSet {
            Task { await sidecarStore.update(model: model, culling: culling) }
        }
    }

    /// Snapshot at session open — used by before/after toggle.
    public private(set) var originalModel: AdjustmentModel

    // MARK: Render output

    @Published public var renderedPreview: CIImage?
    @Published public var renderPhase: RenderPhase = .fast
    @Published public var isRendering: Bool = false

    // MARK: Zoom / pan

    @Published public var zoomScale: Double = 1.0
    @Published public var showingOriginal: Bool = false

    // MARK: Undo / redo

    private var undoStack: [AdjustmentModel] = []
    private var redoStack: [AdjustmentModel] = []
    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }

    // MARK: Internals

    private let pipeline: ImageEditPipeline
    private let sidecarStore: XMPSidecarStore
    private var renderTask: Task<Void, Never>?
    private var refineTask: Task<Void, Never>?

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
        renderTask = Task { @MainActor in
            await _render(phase: .fast)
            // Schedule refine after fast completes
            refineTask?.cancel()
            refineTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await _render(phase: .refine)
            }
        }
    }

    private func _render(phase: RenderPhase) async {
        isRendering = true
        renderPhase = phase
        let m = model
        let asset = self.asset
        let image = await Task.detached(priority: .userInitiated) {
            await self.pipeline.render(asset: asset, model: m, phase: phase)
        }.value
        renderedPreview = image
        isRendering = false
    }
}
