// PipelineRenderer+CaptureDecode.swift — the capture decode's buffer as
// Swift data (#5377), the refine base the sized decode keeps (#5381), and
// the GPU capture refine that re-runs chroma prefilter, deep denoise and
// capture sharpening from that base instead of re-developing the RAW.

import Foundation
import RawPipeline

/// A capture decode's refine base: the as-shot basis after retouch, before
/// the three GPU-refinable stages (#5381). Rust-owned and read-only, so a
/// refine may run on it from any task; freed when the last reference goes.
public final class CaptureBase: @unchecked Sendable {
  let pointer: OpaquePointer

  init(_ pointer: OpaquePointer) {
    self.pointer = pointer
  }

  deinit {
    maple_free_capture_base(pointer)
  }
}

/// How large a capture refine this device runs on the GPU (#5213 decision
/// 7): the longest base edge, and the BM3D binding cap. A larger decode
/// re-develops on the CPU instead.
public enum CaptureRefineBudget {
  /// The iPhone capture edge; its decodes clamp to it while a refinable
  /// stage is engaged (see `clampedDecodeTarget`).
  public static let phoneLongEdge: UInt32 = 1536

  public static var current: MapleCaptureRefineBudget {
    #if os(macOS)
      MapleCaptureRefineBudget(max_long_edge: 2560, bm3d_binding_cap_bytes: 128 << 20)
    #else
      MapleCaptureRefineBudget(max_long_edge: phoneLongEdge, bm3d_binding_cap_bytes: 32 << 20)
    #endif
  }
}

extension PipelineRenderer {
  /// The capture refine declined: the edit changes more than the refinable
  /// stages, or the base is over the budget. The caller re-develops.
  static let rcNotRefinable: Int32 = 10

  /// Copy a capture decode (or refine) into Swift-owned data and free it.
  static func captureImageData(
    _ capture: inout MapleCaptureBufferF32, rc: Int32, base: CaptureBase?, emptyMessage: String
  ) throws -> MapleSceneLinearImageData {
    if rc == rcCancelled {
      throw PipelineError.cancelled
    }
    guard rc == 0 else {
      let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
      throw PipelineError.renderFailed(code: Int(rc), message: msg)
    }
    defer { maple_free_capture_buffer_f32(&capture) }
    let buf = capture.scene
    guard buf.len_bytes > 0, let ptr = buf.f32_rgba else {
      throw PipelineError.renderFailed(code: Int(rc), message: emptyMessage)
    }
    let data = mapleStage("decode result copy") {
      Data(bytes: ptr, count: Int(buf.len_bytes))
    }
    let noiseProfile: [Float]? = {
      guard buf.noise_profile_len > 0, let npPtr = buf.noise_profile_data else { return nil }
      return Array(UnsafeBufferPointer(start: npPtr, count: Int(buf.noise_profile_len)))
    }()
    return MapleSceneLinearImageData(
      width: Int(buf.width),
      height: Int(buf.height),
      channels: Int(buf.channels),
      bytesPerPixel: Int(buf.bytes_per_pixel),
      pixels: data,
      noiseProfile: noiseProfile,
      iso: buf.iso,
      wbFrame: WbSliderFrame(buffer: buf, creative: CaptureCreative(capture.creative)),
      aeGain: buf.ae_gain,
      whitesAnchorEv: buf.whites_anchor_ev, nrSamplingScale: buf.nr_sampling_scale,
      hasLensCorrections: buf.has_lens_corrections != 0,
      lensCorrectionCaInert: buf.lens_correction_ca_inert != 0,
      lensCorrectionDistortionInert: buf.lens_correction_distortion_inert != 0,
      cameraSupport: RawCameraSupport.fromFFI(buf.camera_support_json.map { UnsafePointer($0) }),
      captureBase: base
    )
  }

  /// Whether a decode capped at `maxLongEdge` can ever be refined here, and
  /// so is worth keeping a refine base for (a whole extra image in memory).
  /// The GPU kill switch (`MAPLE_GPU_LIVE=0`) turns the refine off too.
  static func keepsRefineBase(maxLongEdge: UInt32, gpuEnabled: Bool = GpuLiveFlag.isEnabled)
    -> Bool
  {
    gpuEnabled && maxLongEdge <= CaptureRefineBudget.current.max_long_edge
  }

  /// The sized capture decode, with its refine base when the device could
  /// refine it (file source).
  static func renderCaptureSized(
    rawCStr: UnsafePointer<CChar>, xmpCStr: UnsafePointer<CChar>?, quality: Quality,
    maxLongEdge: UInt32, cancel: CancelFlag?
  ) throws -> MapleSceneLinearImageData {
    var capture = MapleCaptureBufferF32()
    var base: OpaquePointer?
    let rc =
      keepsRefineBase(maxLongEdge: maxLongEdge)
      ? maple_render_file_capture_base_f32(
        rawCStr, xmpCStr, maxLongEdge, quality.rawValue, cancel?.pointer, &capture, &base)
      : maple_render_file_capture_sized_f32(
        rawCStr, xmpCStr, maxLongEdge, quality.rawValue, cancel?.pointer, &capture)
    return try captureImageData(
      &capture, rc: rc, base: base.map(CaptureBase.init), emptyMessage: "empty sized buffer")
  }

  /// The bytes-source sibling of `renderCaptureSized(rawCStr:…)`.
  static func renderCaptureSized(
    ptr: UnsafePointer<UInt8>?, len: Int, hintCStr: [CChar], xmpCStr: UnsafePointer<CChar>?,
    quality: Quality, maxLongEdge: UInt32, cancel: CancelFlag?
  ) throws -> MapleSceneLinearImageData {
    var capture = MapleCaptureBufferF32()
    var base: OpaquePointer?
    let keepBase = keepsRefineBase(maxLongEdge: maxLongEdge)
    let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
      keepBase
        ? maple_render_bytes_capture_base_f32(
          ptr, UInt(len), hintPtr.baseAddress, xmpCStr, maxLongEdge, quality.rawValue,
          cancel?.pointer, &capture, &base)
        : maple_render_bytes_capture_sized_f32(
          ptr, UInt(len), hintPtr.baseAddress, xmpCStr, maxLongEdge, quality.rawValue,
          cancel?.pointer, &capture)
    }
    return try captureImageData(
      &capture, rc: rc, base: base.map(CaptureBase.init), emptyMessage: "empty sized buffer")
  }

  /// Refine `base` on the GPU to the decode-baked model in `xmpPath`
  /// (stripped and overridden exactly as the decode was), or `nil` when
  /// the refine declines and the caller must re-develop. Cancelling `cancel`
  /// stops it at the next BM3D tile and throws `PipelineError.cancelled`; it
  /// never returns a partial refine.
  public static func refineCapture(
    base: CaptureBase,
    xmpPath: URL?,
    profileOverride: Profile? = nil,
    autoExposureOverride: AutoExposureMode? = nil,
    budget: MapleCaptureRefineBudget = CaptureRefineBudget.current,
    cancel: CancelFlag? = nil
  ) throws -> MapleSceneLinearImageData? {
    try RawCoreBridge.withStrippedXMP(
      xmpPath, profileOverride: profileOverride, autoExposureOverride: autoExposureOverride
    ) { strippedXMP in
      var capture = MapleCaptureBufferF32()
      let refine = { (xmpCStr: UnsafePointer<CChar>?) -> Int32 in
        maple_gpu_capture_refine(base.pointer, xmpCStr, budget, cancel?.pointer, &capture)
      }
      let rc = try strippedXMP.map { url in try url.withPathCString { refine($0) } } ?? refine(nil)
      guard rc != rcNotRefinable else { return nil }
      return try withExtendedLifetime(base) {
        try captureImageData(&capture, rc: rc, base: base, emptyMessage: "empty refine buffer")
      }
    }
  }
}
