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

/** Convert exifr's raw values to the Asset fields consumed by Info. */
export function hostedInfoFields(raw: Record<string, unknown> | undefined): Partial<Asset> {
  if (!raw) return {};
  const camera = text(raw['Model']) ?? text(raw['Make']);
  const lens = text(raw['LensModel']) ?? text(raw['Lens']);
  const apertureValue = number(raw['ApertureValue']);
  const aperture =
    number(raw['FNumber']) ??
    (apertureValue === undefined ? undefined : Math.round(10 * 2 ** (apertureValue / 2)) / 10);
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
