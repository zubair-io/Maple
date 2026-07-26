// EditorState+AutoReset.swift — AUTO (#1379) and RESET (#1372) methods.
//
// Pure code-move from EditorState.swift to clear the 600-LOC file budget.
// Stored properties (`autoInProgress`, `autoGeneration`, `autoProvider`)
// remain in the main class body — stored properties cannot live in
// extensions on @Observable classes.

import Foundation

extension EditorState {

    // MARK: Reset to factory defaults (#1372)

    /// Reset every develop slider to its FACTORY default, point white balance
    /// at the camera's As-Shot reading (falling back to the 6500 K / 0 default
    /// when no As-Shot value was captured), and restore the Auto profile.
    /// Crop / rotation is deliberately preserved — RESET clears develop
    /// adjustments, never the user's framing. Applied as ONE undo entry
    /// (`commit()` then a single `session.model` write, mirroring
    /// `applyPreset`). (#1372)
    public func resetToFactoryDefaults() {
        commit()
        var m = AdjustmentModel.default
        m.crop = session.model.crop // preserve crop / rotation
        if let cct = session.asShotCCT, let tint = session.asShotTint {
            m.temperature = cct
            m.tint = tint
        }
        m.profile = .auto
        session.model = m
    }

    // MARK: AUTO (#1379)

    /// Analyse the scene and apply AUTO's **exposure** as ONE undo entry
    /// (`commit()` then a single `session.model` write). Async — the analysis
    /// decodes + develops a probe buffer. Generation-guarded so a stale result
    /// can't overwrite a newer edit / image switch.
    ///
    /// AUTO is exposure-only: white balance is intentionally NOT written
    /// (single-image gray-world WB is unreliable on colour-dominant scenes — it
    /// skews green on foliage, warm on skin — so As-Shot stays the default), and
    /// the tone sliders are deferred to #1376. The exposure uses highlight-
    /// protected metering so a bright sky / background can't be blown out.
    ///
    /// AE contract: AUTO's exposure is measured against an AE-Off probe. On the
    /// default `Profile.auto` the Apple decode already forces auto-exposure off
    /// internally whenever an Auto Profile curve will fit, so the recommendation
    /// lands correctly there regardless; on `Profile.neutral`
    /// nothing forces that, so applying AUTO's exposure on top of an AE-On decode
    /// would double-count the anchor gain and blow out highlights. #1387 closes
    /// that gap: `autoExposure` is set to `.off` alongside `exposure`, on every
    /// profile, so the decode this recommendation is valid for is always the one
    /// that actually renders.
    public func applyAuto() async {
        guard let url = session.asset.primaryURL else { return } // RAW path only
        autoGeneration &+= 1
        let gen = autoGeneration
        autoInProgress = true
        defer { if gen == autoGeneration { autoInProgress = false } }

        let result: AutoAdjustmentsResult
        do {
            result = try await autoProvider(url)
        } catch {
            return // leave the model untouched; the button re-enables
        }
        // Drop a stale result: a newer AUTO ran, or the user switched images.
        guard gen == autoGeneration, session.asset.primaryURL == url else { return }

        func clamp(_ v: Double, _ r: ClosedRange<Double>) -> Double {
            min(max(v, r.lowerBound), r.upperBound)
        }
        commit()
        var m = session.model
        // AUTO applies EXPOSURE only. White balance is intentionally NOT touched:
        // single-image gray-world WB is unreliable on colour-dominant scenes
        // (it skews green on foliage, warm on skin), so As-Shot stays the
        // trustworthy default. Tone is deferred to #1376.
        m.exposure = clamp(result.exposure, AdjustmentModel.exposureRange)
        // #1387: the exposure recommendation is measured against an AE-Off
        // probe (see `autoProvider`), so pin the decode to match — otherwise
        // a `Profile.neutral` decode keeps auto_exposure On
        // and AE-lift stacks with AUTO's lift, blowing out highlights.
        m.autoExposure = .off
        session.model = m
    }
}
