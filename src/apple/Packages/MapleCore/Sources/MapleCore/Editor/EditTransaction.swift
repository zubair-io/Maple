// EditTransaction.swift — the one object every committed editor action
// becomes (#2432, milestone 13 · Release Contract & Qualification; design
// spec docs/strategy/milestones/m1-release-contract.md § #2432).
//
// A transaction carries a stable per-session id, the action class, a
// user-visible description, the semantic before/after model state, a
// deterministic sidecar diff, and the render-invalidation scope that diff
// implies. `EditSession`'s undo/redo ring stores transactions (not whole
// model snapshots), the sidecar store receives `after`, the render
// scheduler reads `invalidation`, and the accessibility announcer speaks
// `description` — one object, four consumers. Preview-only slider ticks
// never construct one: a transaction exists only between `beginEdit` and
// `endEdit`, and is dropped if the model never changed.
//
// The web `EditorStateService` mirrors this shape by hand
// (`editor/edit-transaction.ts`); the diff format below — canonical XMP
// attribute keys with their serialized values — is what makes the two
// comparable byte for byte, because the sidecar contract already
// guarantees both serializers emit identical attributes for the same
// model (docs/xmp-canonical-format.md).

import Foundation

/// One changed canonical sidecar attribute. `nil` means the attribute is
/// absent on that side (omitted-on-default).
public struct SidecarFieldChange: Equatable, Sendable, Hashable {
    public let key: String
    public let before: String?
    public let after: String?

    public init(key: String, before: String?, after: String?) {
        self.key = key
        self.before = before
        self.after = after
    }
}

/// What a committed change forces the render path to redo.
public enum InvalidationScope: String, Equatable, Sendable {
    /// Nothing changed — no transaction is recorded for this.
    case none
    /// Only the crop rect / straighten angle moved: the developed pixels
    /// are unchanged, the canvas re-frames them.
    case crop
    /// A develop-chain field moved: re-run the live chain on the cached
    /// decode.
    case develop
    /// A decode-product field moved (chroma prefilter, deep denoise, hot
    /// pixels, lens corrections, capture sharpening): the decoded image
    /// itself is stale and must be re-produced before the chain runs.
    case decode

    /// Classify a model transition. Single classifier for the session's
    /// `model.didSet` crop fast-path AND the transaction ring, so the two
    /// can never disagree about what a change costs.
    public static func classify(from a: AdjustmentModel, to b: AdjustmentModel) -> InvalidationScope {
        guard a != b else { return .none }
        if decodeInputs(a) != decodeInputs(b) { return .decode }
        var aStripped = a
        var bStripped = b
        aStripped.crop = .identity
        bStripped.crop = .identity
        return aStripped == bStripped ? .crop : .develop
    }

    /// The fields whose change forces a re-decode (the decode-product
    /// family, see `AdjustmentModel`'s doc comment on `lensProfileEnable`).
    /// Compared field by field — no hashing, so two values can never be
    /// mistaken for equal.
    private static func decodeInputs(_ m: AdjustmentModel) -> DecodeInputs {
        DecodeInputs(
            chromaPrefilter: m.chromaPrefilter,
            deepDenoise: m.deepDenoise,
            hotPixelSuppression: m.hotPixelSuppression,
            lensProfileEnable: m.lensProfileEnable,
            lensCorrectionDistortion: m.lensCorrectionDistortion,
            lensCorrectionCa: m.lensCorrectionCa,
            lensCorrectionVignetting: m.lensCorrectionVignetting,
            captureSharpeningAmount: m.captureSharpeningAmount,
            captureSharpeningSigma: m.captureSharpeningSigma)
    }

    private struct DecodeInputs: Equatable {
        let chromaPrefilter: Double
        let deepDenoise: Double
        let hotPixelSuppression: HotPixelSuppressionMode
        let lensProfileEnable: LensProfileEnable
        let lensCorrectionDistortion: Double
        let lensCorrectionCa: Double
        let lensCorrectionVignetting: Double
        let captureSharpeningAmount: Double
        let captureSharpeningSigma: Double
    }
}

/// A committed editor action.
public struct EditTransaction: Equatable, Sendable {
    /// Bumped when the serialized form changes shape. Mirrored by the web
    /// `EDIT_TRANSACTION_VERSION`.
    public static let serializationVersion = 1

    /// The action classes the contract covers. `mask`, `repair`, and
    /// `variant` are declared so the surfaces that ship them route through
    /// the same object; nothing constructs them on Apple today (masks are
    /// not surfaced, repair and variants have no editor entry point).
    public enum Kind: String, Equatable, Sendable, CaseIterable {
        case adjustment
        case auto
        case crop
        case paste
        case preset
        case reset
        case mask
        case repair
        case variant
    }

    /// Monotonic per session; stable for the session's lifetime.
    public let id: UInt64
    public let kind: Kind
    /// User-visible, announced to assistive technology on commit.
    public let description: String
    public let before: AdjustmentModel
    public let after: AdjustmentModel
    /// Canonical sidecar attributes that differ between `before` and
    /// `after`, sorted by key. Deterministic: two transactions between the
    /// same models always produce the same diff.
    public let diff: [SidecarFieldChange]
    public let invalidation: InvalidationScope

    /// Build a transaction, computing the diff and scope. Returns `nil`
    /// when the models are semantically identical — a no-op is not an
    /// action and must not enter history.
    public static func make(
        id: UInt64, kind: Kind, description: String,
        before: AdjustmentModel, after: AdjustmentModel
    ) -> EditTransaction? {
        let diff = SidecarDiff.between(before, after)
        let scope = InvalidationScope.classify(from: before, to: after)
        guard !diff.isEmpty || scope != .none else { return nil }
        return EditTransaction(
            id: id, kind: kind, description: description,
            before: before, after: after, diff: diff, invalidation: scope)
    }

    /// The bounded, versioned wire form: no model snapshots, only the
    /// semantic diff (at most one entry per canonical attribute).
    public func serialized() -> [String: Any] {
        [
            "version": Self.serializationVersion,
            "id": id,
            "kind": kind.rawValue,
            "description": description,
            "invalidation": invalidation.rawValue,
            "diff": diff.map { change -> [String: Any] in
                [
                    "key": change.key,
                    "before": change.before as Any? ?? NSNull(),
                    "after": change.after as Any? ?? NSNull(),
                ]
            },
        ]
    }

    /// Canonical JSON (sorted keys, no whitespace) of `serialized()`.
    public func serializedJSON() -> String {
        let data = try! JSONSerialization.data(
            withJSONObject: serialized(), options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }
}

/// Deterministic sidecar diff between two models.
public enum SidecarDiff {
    /// Every canonical attribute the sidecar writer would emit for `model`
    /// that differs from what it emits for the default model, plus the
    /// nested tone-curve block under the synthetic key `toneCurves` (curves
    /// are children, not attributes). Subtracting the default-model emission
    /// gives both platforms omit-on-default semantics: the Apple writer
    /// emits the core `crs:` block unconditionally where the Web writer
    /// omits it at default (docs/xmp-canonical-format.md § "Known
    /// divergence"), and without this step the two diffs would disagree on
    /// `before` for every first edit of a default field. Culling is held
    /// fixed so only model-derived keys can differ between two calls.
    public static func attributes(of model: AdjustmentModel) -> [String: String] {
        let defaults = Dictionary(
            XMPSerializer._buildAttrs(model: .default, culling: CullingState()),
            uniquingKeysWith: { _, last in last })
        var out: [String: String] = [:]
        for (key, value) in XMPSerializer._buildAttrs(model: model, culling: CullingState())
        where defaults[key] != value {
            out[key] = value
        }
        let curves = XMPSerializer._buildToneCurvesBlock(model: model, indent: "")
        if !curves.isEmpty {
            out["toneCurves"] = curves
        }
        return out
    }

    /// The attributes that differ, sorted by key.
    public static func between(_ a: AdjustmentModel, _ b: AdjustmentModel) -> [SidecarFieldChange] {
        let before = attributes(of: a)
        let after = attributes(of: b)
        let keys = Set(before.keys).union(after.keys).sorted()
        return keys.compactMap { key in
            let x = before[key]
            let y = after[key]
            return x == y ? nil : SidecarFieldChange(key: key, before: x, after: y)
        }
    }
}
