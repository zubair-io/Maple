import { InjectionToken } from '@angular/core';
import type { Asset } from '../models/asset';

/** Enabled by the Hosted workspace provider; other workspaces keep indexed EXIF. */
export const HOSTED_INFO_EXIF_ENABLED = new InjectionToken<boolean>('HOSTED_INFO_EXIF_ENABLED');

/** Read only the tags shown in Preview Info for the selected Hosted photo. */
export const HOSTED_INFO_EXIF_TAGS = [
  'Make',
  'Model',
  'LensModel',
  'Lens',
  'FNumber',
  'ApertureValue',
  'MakerNote',
  'ExposureTime',
  'ISO',
  'FocalLength',
  'GPSLatitude',
  'GPSLongitude',
] as const;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function shutter(value: unknown): string | undefined {
  const given = text(value);
  if (given) return given;
  const seconds = number(value);
  if (seconds === undefined) return undefined;
  if (seconds >= 1) return `${seconds}s`;
  const denominator = Math.round(1 / seconds);
  return denominator >= 2 && Math.abs(seconds - 1 / denominator) / seconds < 0.01
    ? `1/${denominator}`
    : `${seconds}s`;
}

/** Leica M10/S MakerNote format 9 stores FNumber as an inline int32 / 1000.
 * Other maker-note layouts must not produce a plausible but false aperture. */
function leicaM10Aperture(value: unknown): number | undefined {
  if (!(value instanceof Uint8Array) || value.length < 22) return undefined;
  const header = [0x4c, 0x45, 0x49, 0x43, 0x41, 0, 2, 0]; // LEICA\0\x02\0
  if (header.some((byte, i) => value[i] !== byte)) return undefined;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const found: number[] = [];
  for (const littleEndian of [true, false]) {
    const count = view.getUint16(8, littleEndian);
    if (count < 1 || count > 256 || 10 + count * 12 + 4 > value.length) continue;
    for (let i = 0; i < count; i++) {
      const offset = 10 + i * 12;
      if (
        view.getUint16(offset, littleEndian) !== 0x035a ||
        view.getUint16(offset + 2, littleEndian) !== 9 ||
        view.getUint32(offset + 4, littleEndian) !== 1
      )
        continue;
      const aperture = view.getInt32(offset + 8, littleEndian) / 1000;
      if (aperture >= 0.5 && aperture <= 128) found.push(Math.round(aperture * 10) / 10);
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

/** Convert exifr's raw values to the Asset fields consumed by Info. */
export function hostedInfoFields(raw: Record<string, unknown> | undefined): Partial<Asset> {
  if (!raw) return {};
  const camera = text(raw['Model']) ?? text(raw['Make']);
  const lens = text(raw['LensModel']) ?? text(raw['Lens']);
  const apertureValue = number(raw['ApertureValue']);
  const aperture =
    number(raw['FNumber']) ??
    (apertureValue === undefined ? undefined : Math.round(10 * 2 ** (apertureValue / 2)) / 10) ??
    leicaM10Aperture(raw['makerNote']);
  const exposure = shutter(raw['ExposureTime']);
  const iso = number(raw['ISO']);
  const focalLength = number(raw['FocalLength']);
  const lat = raw['GPSLatitude'];
  const lon = raw['GPSLongitude'];
  return {
    ...(camera ? { camera } : {}),
    ...(lens ? { lens } : {}),
    ...(aperture !== undefined ? { aperture: `f/${aperture}` } : {}),
    ...(exposure ? { shutter: exposure } : {}),
    ...(iso !== undefined ? { iso } : {}),
    ...(focalLength !== undefined ? { focalLength: `${focalLength}mm` } : {}),
    ...(typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
      ? { gps: { lat, lon } }
      : {}),
  };
}
