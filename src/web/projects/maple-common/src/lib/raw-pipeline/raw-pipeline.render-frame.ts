// Shared owned-buffer conversion for ordinary and saved RAW previews (#3955).
import { cameraSupportFromJson } from '../state/camera-support';
import { lensProfileFromJson } from '../lens/lens-profile.metadata';
import type { DecodeSuccess } from './raw-pipeline.types';
import type { MapleRender } from './pkg/raw_wasm';

export function takeRenderFrame(result: MapleRender): Omit<DecodeSuccess, 'id' | 'type'> {
  try {
    const metadata = {
      cropInputWidth: result.crop_input_width || undefined,
      cropInputHeight: result.crop_input_height || undefined,
      width: result.width,
      height: result.height,
      nativeWidth: result.full_width,
      nativeHeight: result.full_height,
      asShotTemperature: result.as_shot_temperature,
      asShotTint: result.as_shot_tint,
      hasLensCorrections: result.has_lens_corrections,
      lensCorrectionCaInert: result.lens_correction_ca_inert,
      cameraSupport: cameraSupportFromJson(result.camera_support_json),
      lensProfile: lensProfileFromJson(result.lens_profile_json),
      autoFit: result.auto_fit,
    };
    return { ...metadata, rgb: result.take_rgb().slice().buffer as ArrayBuffer };
  } finally {
    result.free();
  }
}
