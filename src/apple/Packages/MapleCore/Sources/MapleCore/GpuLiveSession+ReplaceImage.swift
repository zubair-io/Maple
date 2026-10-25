// GpuLiveSession+ReplaceImage.swift — publish a same-size re-decode, such as
// a GPU capture refine (#5381), into the open session in one write instead
// of tearing the session down and opening another.

import Foundation
import RawPipeline

extension GpuLiveSession {
  /// Whether pixels with these dims and exports can replace the upload:
  /// nothing else the session was opened with may differ.
  func accepts(width: Int, height: Int, exports: GpuUploadExports) -> Bool {
    handle != nil && width == self.width && height == self.height
      && (exports.noiseProfile ?? []) == noiseProfile && exports.iso == iso
      && exports.whitesAnchorEv.bitPattern == whitesAnchorEv.bitPattern
      && exports.nrSamplingScale == nrSamplingScale
  }

  /// Replace the uploaded pixels. The replacement is one queue write behind
  /// every render already issued on this actor, so a frame shows the old
  /// image or the new one, never a mix. `false` means the caller must
  /// reopen instead.
  func replaceImage(pixels: [Float], width: Int, height: Int, exports: GpuUploadExports) throws
    -> Bool
  {
    guard accepts(width: width, height: height, exports: exports), var h = handle,
      pixels.count == width * height * 4
    else { return false }
    let rc = pixels.withUnsafeBufferPointer { buf in
      maple_gpu_live_update_image(&h, buf.baseAddress, UInt32(width), UInt32(height))
    }
    guard rc == 0 else {
      throw GpuLiveError(message: Self.lastError() ?? "maple_gpu_live_update_image rc=\(rc)")
    }
    return true
  }
}
