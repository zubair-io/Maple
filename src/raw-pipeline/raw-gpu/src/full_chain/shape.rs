//! [`InputShape`], split out of `full_chain.rs` to keep that module inside the
//! file-size budget (same split shape as `live_chain`'s `noop` / `signature`).
//! Re-exported, so every `full_chain::InputShape` path keeps working.

/// How the GPU-resident image was produced. Drives which leading stages the live
/// chain must run at the start of each render tick.
///
/// The zero-value `PostDcpRec2020Fp16` is the *default* — the historic RAW path
/// that ran before this enum was introduced — so any `FullChainInputs` zeroed
/// by a legacy caller correctly resolves to the full RAW chain. The non-zero
/// values engage the two new non-RAW branches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum InputShape {
    /// Scene-linear Rec.2020 fp16 after the full RAW decode (DCP + WB at D65/
    /// 6500K). All chain stages run: WB delta → scene tone → … → view tail.
    /// Value 0 — the historic default.
    #[default]
    PostDcpRec2020Fp16 = 0,
    /// 16-bit linear Rec.2020 input (pano PNG output). The WB / DCP / AE
    /// stages have no meaning — the buffer is already in the correct colour
    /// space — so the live chain starts at the first user-edit stage
    /// (scene_tone_controls). WB and capture_sharpening are skipped.
    LinearRec2020Fp16 = 1,
    /// 8-bit sRGB gamma-encoded input (JPEG / HEIF / 8-bit PNG). A CPU
    /// pre-pass at session-open time converts to scene-linear Rec.2020
    /// (`sRGB→linear + sRGB→Rec.2020 primaries matrix`), after which the
    /// same stage subset as `LinearRec2020Fp16` runs.
    SrgbGammaEncoded8 = 2,
}
