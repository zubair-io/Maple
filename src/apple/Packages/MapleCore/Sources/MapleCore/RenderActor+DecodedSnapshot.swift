import CoreImage
import Foundation

// Decode metadata travels with the buffer and its cache identity.
extension RenderActor {
  public struct DecodedSnapshot: Sendable {
    public let image: CIImage?
    public let decodedAtModel: AdjustmentModel?
    public let rawResolution: CGSize
    public let isFresh: Bool
    /// True when the cached decode is full-resolution (sufficient for
    /// refine / deep-zoom crops). A sized fast decode or a seeded
    /// preview buffer is `false` — refine must re-decode (#785).
    public let isFull: Bool
    /// Profile the cached buffer was developed for (#871), or `nil` for
    /// non-RAW / seeded buffers. The render path compares this to the
    /// live profile and treats a mismatch as a miss so a profile toggle
    /// re-decodes the (profile-dependent, AE-Off-for-Auto) buffer.
    public let profile: Profile?
    /// Auto-exposure mode the cached buffer was developed for (#1387),
    /// `nil` for non-RAW / seeded buffers — mirrors `profile` above.
    public let autoExposure: AutoExposureMode?
    /// Per-camera noise profile from the RAW decode (PR #1709 review fix 4).
    /// `nil` when the DNG carries no NoiseLevelFunction tag or the buffer
    /// was seeded from a display-encoded preview.
    public let noiseProfile: [Float]?
    /// ISO speed from the RAW decode (PR #1709 review fix 4). 0 for seeded
    /// / non-RAW buffers; the Rust chain substitutes 100 on its side.
    public let iso: UInt32
    /// Decode-exported WB slider frame (#1781). `nil` for seeded /
    /// non-RAW buffers or frame-less bodies.
    public let wbFrame: WbSliderFrame?
    /// Decode-exported auto-exposure gain (#1167/#2070). `1.0` for
    /// seeded / non-RAW buffers or frame-less bodies (see
    /// `MapleSceneLinearImageData.aeGain`) — never optional, unlike
    /// `wbFrame`, since `1.0` is itself a meaningful no-op gain.
    /// `NativeDetailRenderer.render` takes this as its `aeGain`
    /// parameter so a native-detail tile matches the full-image AE
    /// brightness of the buffer currently on screen.
    public let aeGain: Float
    /// The decode-cache write generation the cached buffer was written
    /// under (#2049) — see `RenderActor.decodeGeneration`. Threaded into
    /// `presentViaGpuLive` so the GPU-live upload identity can detect a
    /// same-dims re-decode (a baked-field edit) and re-upload instead of
    /// silently presenting the live chain over stale pixels.
    public let decodeGeneration: UInt64
    /// Whether the cached buffer's RAW carries lens-correction opcodes
    /// and whether the CA/distortion sliders are inert (#2231, #3189)
    /// — see `ImageEditPipeline.SceneLinearDecodeResult`'s doc comments.
    public let hasLensCorrections: Bool
    public let lensCorrectionCaInert: Bool
    public let lensCorrectionDistortionInert: Bool
    public let cameraSupport: RawCameraSupport?
  }
}
